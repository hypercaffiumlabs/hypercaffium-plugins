// Safety tiers for App Store Connect changes. This is enforced by the server, not just by instructions.
//
//   Tier 3  BLOCKED   never executed by this plugin; no ticket is even issued
//   Tier 2  CONFIRM   preview, then a human "yes" (the apply tool prompts in Claude Code)
//   Tier 1  AUTO      small allowlist of low-risk, non-live edits; may run without a prompt
//
// Anything not listed is Tier 2. When in doubt, a rule must fall to a HIGHER tier, never lower.

// Version states in which the listing is still a private draft (not live, not in review).
export const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

const BLOCKED = [
  {
    test: (op) => op.method === 'DELETE',
    reason: 'Deleting is blocked. Nothing in this plugin removes data from App Store Connect.',
  },
  {
    test: (_op, path) => /^\/v\d\/(users|userInvitations|apiKeys|certificates|profiles|devices|bundleIds|merchantIds|passTypeIds)(\/|$)/.test(path),
    reason: 'Users, access, API keys and code-signing are never changed by this plugin.',
  },
];

// Always-safe: TestFlight "What to test" notes. Visible only to testers, easy to edit back.
const TIER1_STATIC = [
  { method: 'POST', re: /^\/v1\/betaBuildLocalizations$/, reason: 'TestFlight "What to test" notes' },
  { method: 'PATCH', re: /^\/v1\/betaBuildLocalizations\/[^/]+$/, reason: 'TestFlight "What to test" notes' },
  // A new draft version is invisible to users until it is submitted and approved.
  { method: 'POST', re: /^\/v1\/appStoreVersions$/, reason: 'creating a new draft version (not visible to users)' },
];

// Safe only while the App Store version is still an editable draft. The server looks this up.
export const TIER1_IF_DRAFT = [
  {
    method: 'PATCH',
    re: /^\/v1\/appStoreVersionLocalizations\/([^/]+)$/,
    // A localization has no "parent version" endpoint; include= returns the version alongside it.
    versionPath: (id) => `/v1/appStoreVersionLocalizations/${id}?include=appStoreVersion`,
    reason: 'listing text of a draft version',
  },
  {
    method: 'PATCH',
    re: /^\/v1\/appStoreVersions\/([^/]+)$/,
    versionPath: (id) => `/v1/appStoreVersions/${id}`,
    reason: 'settings of a draft version',
  },
  {
    method: 'PATCH',
    re: /^\/v1\/appStoreVersions\/([^/]+)\/relationships\/build$/,
    versionPath: (id) => `/v1/appStoreVersions/${id}`,
    reason: 'choosing the build of a draft version',
  },
  {
    method: 'PATCH',
    re: /^\/v1\/appStoreReviewDetails\/([^/]+)$/,
    versionPath: (id) => `/v1/appStoreReviewDetails/${id}?include=appStoreVersion`,
    reason: 'App Review details of a draft version',
  },
];

// The version's state: from the included version (localization lookups) or from the version itself.
const stateOf = (body) => {
  const v = body?.included?.find((i) => i.type === 'appStoreVersions') || body?.data;
  return v?.attributes?.appStoreState || v?.attributes?.appVersionState || null;
};

// The ONE kind of delete that is allowed: a single screenshot that belongs to a version that is still
// a draft (it can simply be uploaded again). The server proves this by walking
// screenshot -> set -> localization -> version. If any link cannot be proven, the delete stays blocked.
const SCREENSHOT_DELETE = /^\/v1\/appScreenshots\/([^/]+)$/;

async function classifyScreenshotDelete(id, lookup, early) {
  if (early) return { tier: 2, reason: 'a screenshot removal; the version state is checked before it is allowed' };
  const blocked = (why) => ({ tier: 3, reason: `Deleting is blocked. Only a screenshot of a draft version can be removed (${why}).` });
  try {
    const shot = await lookup(`/v1/appScreenshots/${id}?include=appScreenshotSet`);
    const setId = shot?.included?.find((i) => i.type === 'appScreenshotSets')?.id || shot?.data?.relationships?.appScreenshotSet?.data?.id;
    if (!setId) return blocked('could not find which set it belongs to');
    const set = await lookup(`/v1/appScreenshotSets/${setId}?include=appStoreVersionLocalization`);
    const locId = set?.included?.find((i) => i.type === 'appStoreVersionLocalizations')?.id || set?.data?.relationships?.appStoreVersionLocalization?.data?.id;
    if (!locId) return blocked('it is not part of an App Store version listing');
    const state = stateOf(await lookup(`/v1/appStoreVersionLocalizations/${locId}?include=appStoreVersion`));
    if (state && EDITABLE_VERSION_STATES.has(state)) {
      return { tier: 2, reason: `removing a screenshot from a draft version (state ${state}); it can be uploaded again` };
    }
    return blocked(`its version is ${state || 'in an unknown state'}`);
  } catch {
    return blocked('could not confirm the version is a draft');
  }
}

// lookup(path) -> parsed JSON of a GET, or throws. Any failure falls back to the safer tier.
// opts.early: classify from the operation alone (no real ids yet), used to reject blocked things fast.
export async function classify(op, filledPath, lookup, opts = {}) {
  if (op.method === 'DELETE') {
    const m = SCREENSHOT_DELETE.exec(filledPath);
    if (m) return classifyScreenshotDelete(decodeURIComponent(m[1]), lookup, Boolean(opts.early));
  }
  for (const b of BLOCKED) {
    if (b.test(op, filledPath)) return { tier: 3, reason: b.reason };
  }
  for (const r of TIER1_STATIC) {
    if (op.method === r.method && r.re.test(filledPath)) return { tier: 1, reason: r.reason };
  }
  for (const r of TIER1_IF_DRAFT) {
    const m = op.method === r.method && r.re.exec(filledPath);
    if (!m) continue;
    try {
      const state = stateOf(await lookup(r.versionPath(m[1])));
      if (state && EDITABLE_VERSION_STATES.has(state)) {
        return { tier: 1, reason: `${r.reason} (version state is ${state}, so it is not live)` };
      }
      return { tier: 2, reason: `this version is ${state || 'in an unknown state'}, so a change could affect users or review` };
    } catch {
      return { tier: 2, reason: 'could not confirm the version is a draft, so confirmation is required' };
    }
  }
  return { tier: 2, reason: tier2Reason(op, filledPath) };
}

// A specific reason beats a generic one: say what is actually at stake.
function tier2Reason(op, path) {
  if (path.startsWith('/v1/customerReviewResponses')) return 'a public reply, visible to everyone on the App Store';
  if (path.startsWith('/v1/betaTesters') || path.endsWith('/relationships/betaTesters')) return 'this adds a tester and Apple may email them an invitation';
  if (path.startsWith('/v1/reviewSubmissions') || path.startsWith('/v1/reviewSubmissionItems')) return 'this affects what is submitted to App Review';
  if (path.startsWith('/v1/appStoreVersionReleaseRequests') || path.includes('PhasedRelease')) return 'this releases or rolls out a version to real users';
  if (/subscription|inAppPurchase|appPrice|winBackOffer|offerCode|promotedPurchase/i.test(path)) return 'this affects pricing or what customers pay';
  if (path.startsWith('/v1/appInfoLocalizations')) return 'the app name and subtitle are public on the store once released';
  return 'changes to your App Store account need your confirmation';
}
