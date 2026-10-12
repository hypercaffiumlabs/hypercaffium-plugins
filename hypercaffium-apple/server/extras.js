// Reviews, App Review details, app info, and TestFlight workflows.
// Everything here only PREPARES a previewed, ticketed change; nothing happens until an apply tool runs.
import { findOperation } from './plans.js';
import { findVersion, flat, list, resolveApp } from './release.js';
import { EDITABLE_VERSION_STATES } from './rules.js';
import { toLocalTime } from './util.js';
import { prepareChange } from './writes.js';

const enc = encodeURIComponent;
const qs = (o) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${enc(String(v))}`).join('&')}` : '';
};
const opFor = (method, path) => {
  const op = findOperation(method, path);
  if (!op) throw new Error(`Apple's API has no ${method} ${path}.`);
  return op;
};
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const HIDDEN = '(hidden)';

// ---- customer reviews ------------------------------------------------------

export async function reviewInbox(deps, { appId, limit = 20, unrepliedOnly = true }) {
  const app = await resolveApp(deps, appId);
  const body = await deps.get(
    `/v1/apps/${enc(app)}/customerReviews${qs({ sort: '-createdDate', include: 'response', limit: Math.min(200, Math.max(50, limit * 3)) })}`,
  );
  const responses = new Map((body.included || []).filter((i) => i.type === 'customerReviewResponses').map((r) => [r.id, flat(r)]));
  const rows = (body.data || []).map((r) => {
    const respId = r.relationships?.response?.data?.id;
    const resp = respId ? responses.get(respId) : null;
    const a = r.attributes || {};
    return {
      id: r.id,
      rating: a.rating,
      title: a.title,
      body: a.body,
      reviewer: a.reviewerNickname,
      territory: a.territory,
      createdLocal: toLocalTime(a.createdDate),
      replied: Boolean(respId),
      reply: resp ? { text: resp.responseBody, state: resp.state, lastModifiedLocal: toLocalTime(resp.lastModifiedDate) } : null,
    };
  });
  const shown = (unrepliedOnly ? rows.filter((r) => !r.replied) : rows).slice(0, limit);
  return { app, unrepliedOnly, totalChecked: rows.length, unreplied: rows.filter((r) => !r.replied).length, reviews: shown };
}

export async function prepareReplyToReview(deps, { reviewId, text }) {
  if (!reviewId) throw new Error('Pass reviewId (from asc_review_inbox).');
  if (typeof text !== 'string' || !text.trim()) throw new Error('The reply needs text.');
  if (text.length > 5970) throw new Error(`The reply is ${text.length} characters; Apple allows at most 5970.`);
  let review;
  try {
    review = flat((await deps.get(`/v1/customerReviews/${enc(reviewId)}`)).data);
  } catch {
    throw new Error(`Review ${reviewId} was not found.`);
  }
  let existing = null;
  try {
    const r = await deps.get(`/v1/customerReviews/${enc(reviewId)}/response`);
    existing = r.data ? flat(r.data) : null;
  } catch {
    existing = null;
  }
  const preview = await prepareChange({
    op: opFor('POST', '/v1/customerReviewResponses'),
    body: {
      data: {
        type: 'customerReviewResponses',
        attributes: { responseBody: text },
        relationships: { review: { data: { type: 'customerReviews', id: reviewId } } },
      },
    },
    deps,
  });
  return {
    ...preview,
    review: { rating: review.rating, title: review.title, body: review.body, reviewer: review.reviewerNickname, territory: review.territory, createdLocal: toLocalTime(review.createdDate) },
    existingReply: existing ? existing.responseBody : null,
    willBePublic: 'This reply is visible to everyone on the App Store, under the developer name.',
    note: existing ? 'Apple replaces the existing reply with this one.' : undefined,
  };
}

// ---- App Review details ----------------------------------------------------

const REVIEW_FIELDS = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail', 'demoAccountRequired', 'demoAccountName', 'demoAccountPassword', 'notes'];

export function checkReviewFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new Error(`Provide at least one field: ${REVIEW_FIELDS.join(', ')}.`);
  for (const [k, v] of entries) {
    if (!REVIEW_FIELDS.includes(k)) throw new Error(`Unknown field "${k}". Allowed: ${REVIEW_FIELDS.join(', ')}.`);
    if (k === 'demoAccountRequired') {
      if (typeof v !== 'boolean') throw new Error('demoAccountRequired must be true or false.');
    } else if (typeof v !== 'string') {
      throw new Error(`"${k}" must be text.`);
    }
  }
  const f = Object.fromEntries(entries);
  if (f.contactEmail !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contactEmail)) throw new Error('contactEmail does not look like an email address.');
  if (f.contactPhone !== undefined && !/^\+?[0-9 ()\-.]{7,20}$/.test(f.contactPhone)) throw new Error('contactPhone must be a phone number such as +15551234567.');
  if (f.notes !== undefined && f.notes.length > 4000) throw new Error(`notes is ${f.notes.length} characters; Apple allows at most 4000.`);
  return f;
}

// Never show the demo password in a preview (the real value stays in the ticket).
function maskReviewPreview(preview) {
  const p = clone(preview);
  if (p.changes) for (const c of p.changes) if (c.field === 'demoAccountPassword') { c.from = c.from ? HIDDEN : c.from; c.to = HIDDEN; }
  if (p.before && 'demoAccountPassword' in p.before) p.before.demoAccountPassword = p.before.demoAccountPassword ? HIDDEN : p.before.demoAccountPassword;
  const attrs = p.requestBody?.data?.attributes;
  if (attrs && 'demoAccountPassword' in attrs) attrs.demoAccountPassword = HIDDEN;
  return p;
}

export async function prepareReviewDetails(deps, { appId, version, fields, platform = 'IOS' }) {
  const attrs = checkReviewFields(fields);
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'editable' });
  let detail = null;
  try {
    const r = await deps.get(`/v1/appStoreVersions/${enc(v.id)}/appStoreReviewDetail`);
    detail = r.data ? flat(r.data) : null;
  } catch {
    detail = null;
  }
  const context = { version: v.versionString, versionState: v.appStoreState || v.appVersionState };
  if (detail) {
    const preview = await prepareChange({
      op: opFor('PATCH', '/v1/appStoreReviewDetails/{id}'),
      pathParams: { id: detail.id },
      body: { data: { type: 'appStoreReviewDetails', id: detail.id, attributes: attrs } },
      deps,
    });
    return { ...context, ...maskReviewPreview(preview) };
  }
  const preview = await prepareChange({
    op: opFor('POST', '/v1/appStoreReviewDetails'),
    body: {
      data: {
        type: 'appStoreReviewDetails',
        attributes: attrs,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } },
      },
    },
    deps,
  });
  return { ...context, creating: true, ...maskReviewPreview(preview) };
}

// ---- app info (name, subtitle, privacy URLs) ------------------------------

const INFO_LIMITS = { name: 30, subtitle: 30 };
const INFO_FIELDS = ['name', 'subtitle', 'privacyPolicyUrl', 'privacyChoicesUrl', 'privacyPolicyText'];

export function checkInfoFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new Error(`Provide at least one field: ${INFO_FIELDS.join(', ')}.`);
  for (const [k, v] of entries) {
    if (!INFO_FIELDS.includes(k)) throw new Error(`Unknown field "${k}". Allowed: ${INFO_FIELDS.join(', ')}.`);
    if (typeof v !== 'string') throw new Error(`"${k}" must be text.`);
    if (INFO_LIMITS[k] && v.length > INFO_LIMITS[k]) throw new Error(`"${k}" is ${v.length} characters; Apple allows at most ${INFO_LIMITS[k]}.`);
    if (k.endsWith('Url') && v !== '' && !/^https:\/\/\S+$/.test(v)) throw new Error(`"${k}" must be a full https:// address.`);
  }
  return Object.fromEntries(entries);
}

export async function prepareAppInfo(deps, { appId, locale = 'en-US', fields }) {
  const attrs = checkInfoFields(fields);
  const app = await resolveApp(deps, appId);
  const infos = list(await deps.get(`/v1/apps/${enc(app)}/appInfos${qs({ limit: 10 })}`));
  const stateOf = (i) => i.appStoreState || i.state;
  const editable = infos.find((i) => EDITABLE_VERSION_STATES.has(stateOf(i)));
  if (!editable) {
    throw new Error(
      `App info can only be changed while a version is being prepared. Current states: ${infos.map((i) => stateOf(i)).join(', ') || 'none'}. Create the next version first (asc_create_version).`,
    );
  }
  const locs = list(await deps.get(`/v1/appInfos/${enc(editable.id)}/appInfoLocalizations${qs({ limit: 50 })}`));
  const hit = locs.find((l) => l.locale === locale);
  const context = { appInfoState: stateOf(editable), locale };
  if (hit) {
    const preview = await prepareChange({
      op: opFor('PATCH', '/v1/appInfoLocalizations/{id}'),
      pathParams: { id: hit.id },
      body: { data: { type: 'appInfoLocalizations', id: hit.id, attributes: attrs } },
      deps,
    });
    return { ...context, publicOnRelease: Boolean(attrs.name || attrs.subtitle), ...preview };
  }
  if (!attrs.name) throw new Error(`No ${locale} app info exists yet; creating one needs a name.`);
  const preview = await prepareChange({
    op: opFor('POST', '/v1/appInfoLocalizations'),
    body: {
      data: {
        type: 'appInfoLocalizations',
        attributes: { locale, ...attrs },
        relationships: { appInfo: { data: { type: 'appInfos', id: editable.id } } },
      },
    },
    deps,
  });
  return { ...context, creatingNewLocale: true, existingLocales: locs.map((l) => l.locale), ...preview };
}

// ---- TestFlight ------------------------------------------------------------

async function findGroup(deps, app, group) {
  const groups = list(await deps.get(`/v1/apps/${enc(app)}/betaGroups${qs({ limit: 50 })}`));
  const hit = groups.find((g) => g.id === group || g.name === group);
  if (!hit) throw new Error(`No TestFlight group "${group}". Groups: ${groups.map((g) => g.name).join(', ') || 'none'}.`);
  return hit;
}

async function findBuild(deps, app, buildNumber) {
  if (!buildNumber) throw new Error('Pass buildNumber (for example "57").');
  const b = list(await deps.get(`/v1/builds${qs({ 'filter[app]': app, 'filter[version]': String(buildNumber), limit: 5 })}`))[0];
  if (!b) throw new Error(`No build "${buildNumber}" found for this app.`);
  return b;
}

export async function testflightOverview(deps, { appId }) {
  const app = await resolveApp(deps, appId);
  const groups = list(await deps.get(`/v1/apps/${enc(app)}/betaGroups${qs({ limit: 50 })}`));
  const out = [];
  for (const g of groups) {
    const [testers, builds] = await Promise.all([
      deps.get(`/v1/betaGroups/${enc(g.id)}/betaTesters${qs({ limit: 1 })}`).catch(() => null),
      deps.get(`/v1/betaGroups/${enc(g.id)}/builds${qs({ limit: 5 })}`).catch(() => null),
    ]);
    out.push({
      id: g.id,
      name: g.name,
      internal: g.isInternalGroup,
      publicLink: g.publicLinkEnabled ? g.publicLink : null,
      hasAccessToAllBuilds: g.hasAccessToAllBuilds,
      testers: testers?.meta?.paging?.total ?? null,
      builds: builds ? list(builds).map((b) => ({ build: b.version, uploadedLocal: toLocalTime(b.uploadedDate), expired: b.expired })) : null,
    });
  }
  return { app, groups: out };
}

export async function prepareTestflightNotes(deps, { appId, buildNumber, locale = 'en-US', whatsNew }) {
  if (typeof whatsNew !== 'string' || !whatsNew.trim()) throw new Error('whatsNew needs text.');
  if (whatsNew.length > 4000) throw new Error(`whatsNew is ${whatsNew.length} characters; TestFlight allows at most 4000.`);
  const app = await resolveApp(deps, appId);
  const build = await findBuild(deps, app, buildNumber);
  const locs = list(await deps.get(`/v1/builds/${enc(build.id)}/betaBuildLocalizations${qs({ limit: 50 })}`));
  const hit = locs.find((l) => l.locale === locale);
  const context = { build: build.version, locale };
  if (hit) {
    return {
      ...context,
      ...(await prepareChange({
        op: opFor('PATCH', '/v1/betaBuildLocalizations/{id}'),
        pathParams: { id: hit.id },
        body: { data: { type: 'betaBuildLocalizations', id: hit.id, attributes: { whatsNew } } },
        deps,
      })),
    };
  }
  return {
    ...context,
    creatingNewLocale: true,
    ...(await prepareChange({
      op: opFor('POST', '/v1/betaBuildLocalizations'),
      body: {
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale, whatsNew },
          relationships: { build: { data: { type: 'builds', id: build.id } } },
        },
      },
      deps,
    })),
  };
}

export async function prepareAddTester(deps, { appId, email, firstName, lastName, group }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('Pass a valid email address.');
  if (!group) throw new Error('Pass group (the TestFlight group name or id).');
  const app = await resolveApp(deps, appId);
  const g = await findGroup(deps, app, group);
  let existing = null;
  try {
    existing = list(await deps.get(`/v1/betaTesters${qs({ 'filter[email]': email, limit: 1 })}`))[0] || null;
  } catch {
    existing = null;
  }
  const note = g.isInternalGroup
    ? 'Internal group: the person must already be a user on your App Store Connect team.'
    : 'External group: Apple emails this person an invitation to TestFlight.';
  if (existing) {
    const preview = await prepareChange({
      op: opFor('POST', '/v1/betaGroups/{id}/relationships/betaTesters'),
      pathParams: { id: g.id },
      body: { data: [{ type: 'betaTesters', id: existing.id }] },
      deps,
    });
    return { group: g.name, existingTester: true, note, ...preview };
  }
  const attributes = { email };
  if (firstName) attributes.firstName = firstName;
  if (lastName) attributes.lastName = lastName;
  const preview = await prepareChange({
    op: opFor('POST', '/v1/betaTesters'),
    body: {
      data: {
        type: 'betaTesters',
        attributes,
        relationships: { betaGroups: { data: [{ type: 'betaGroups', id: g.id }] } },
      },
    },
    deps,
  });
  return { group: g.name, existingTester: false, note, ...preview };
}

export async function prepareAddBuildToGroup(deps, { appId, buildNumber, group }) {
  const app = await resolveApp(deps, appId);
  const g = await findGroup(deps, app, group);
  const build = await findBuild(deps, app, buildNumber);
  if (build.processingState !== 'VALID') throw new Error(`Build ${buildNumber} is ${build.processingState}, not VALID yet.`);
  if (build.expired) throw new Error(`Build ${buildNumber} has expired.`);
  const preview = await prepareChange({
    op: opFor('POST', '/v1/betaGroups/{id}/relationships/builds'),
    pathParams: { id: g.id },
    body: { data: [{ type: 'builds', id: build.id }] },
    deps,
  });
  return {
    group: g.name,
    build: build.version,
    note: g.isInternalGroup ? 'Internal testers get the build right away.' : 'External groups need Apple\'s TestFlight beta review for a new build before testers can install it.',
    ...preview,
  };
}

// External TestFlight testers can only install a build after Apple's beta review. This checks what
// Apple requires first (and returns the problems with NO ticket if anything is missing), then
// prepares the submission.
export async function prepareBetaReview(deps, { appId, buildNumber }) {
  const app = await resolveApp(deps, appId);
  const build = await findBuild(deps, app, buildNumber);
  const problems = [];
  if (build.processingState !== 'VALID') problems.push(`Build ${build.version} is ${build.processingState}, not VALID yet.`);
  if (build.expired) problems.push(`Build ${build.version} has expired.`);
  if (build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined) {
    problems.push('Export compliance is not answered for this build (usesNonExemptEncryption). Answer it in App Store Connect or set it in your build configuration.');
  }

  let existing = null;
  try {
    const sub = await deps.get(`/v1/builds/${enc(build.id)}/betaAppReviewSubmission`);
    existing = sub?.data ? { id: sub.data.id, state: sub.data.attributes?.betaReviewState } : null;
  } catch {
    existing = null; // no submission yet
  }
  if (existing) {
    return {
      allowed: false,
      alreadySubmitted: true,
      build: build.version,
      betaReviewState: existing.state,
      reason: `Build ${build.version} was already submitted for beta review (state: ${existing.state}).`,
    };
  }

  const notes = list(await deps.get(`/v1/builds/${enc(build.id)}/betaBuildLocalizations${qs({ limit: 50 })}`));
  if (!notes.some((n) => (n.whatsNew || '').trim())) {
    problems.push('No "What to Test" notes on this build. Add them with asc_testflight_set_notes.');
  }
  const appInfo = list(await deps.get(`/v1/apps/${enc(app)}/betaAppLocalizations${qs({ limit: 50 })}`));
  if (!appInfo.some((l) => (l.description || '').trim() && (l.feedbackEmail || '').trim())) {
    problems.push('The TestFlight app description and feedback email are not filled in (Test Information in App Store Connect).');
  }
  let detail = null;
  try {
    const d = await deps.get(`/v1/apps/${enc(app)}/betaAppReviewDetail`);
    detail = d?.data?.attributes || null;
  } catch {
    detail = null;
  }
  const missing = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'].filter((k) => !(detail?.[k] || '').trim());
  if (missing.length) problems.push(`Beta App Review contact details are missing: ${missing.join(', ')}.`);
  if (detail?.demoAccountRequired && !(detail.demoAccountName || '').trim()) {
    problems.push('Beta App Review says a demo account is required, but no demo account name is set.');
  }

  if (problems.length) {
    return { allowed: false, build: build.version, readyForBetaReview: false, problems, note: 'Nothing was prepared. Fix these first, then ask again.' };
  }
  const preview = await prepareChange({
    op: opFor('POST', '/v1/betaAppReviewSubmissions'),
    body: { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } } },
    deps,
  });
  return {
    build: build.version,
    readyForBetaReview: true,
    note: 'Apple reviews the build (usually within a day). Once approved, external groups that have this build can install it. Add the build to a group with asc_testflight_add_build_to_group if you have not already.',
    ...preview,
  };
}

// Take one tester out of one TestFlight group (the person and their other groups are untouched).
export async function prepareRemoveTester(deps, { appId, email, group }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('Pass the tester\'s email address.');
  if (!group) throw new Error('Pass group (the TestFlight group name or id).');
  const app = await resolveApp(deps, appId);
  const g = await findGroup(deps, app, group);
  const members = list(await deps.get(`/v1/betaGroups/${enc(g.id)}/betaTesters${qs({ limit: 200 })}`));
  const hit = members.find((t) => String(t.email || '').toLowerCase() === email.toLowerCase());
  if (!hit) throw new Error(`${email} is not in the TestFlight group "${g.name}".`);
  const preview = await prepareChange({
    op: opFor('DELETE', '/v1/betaGroups/{id}/relationships/betaTesters'),
    pathParams: { id: g.id },
    body: { data: [{ type: 'betaTesters', id: hit.id }] },
    deps,
  });
  return {
    group: g.name,
    tester: { email: hit.email, name: [hit.firstName, hit.lastName].filter(Boolean).join(' ') || undefined },
    note: 'They lose access to this group\'s builds. Their other groups are not changed, and they can be added back later.',
    ...preview,
  };
}

// Expire a TestFlight build: testers can no longer install it. Apple cannot un-expire a build.
export async function prepareExpireBuild(deps, { appId, buildNumber }) {
  const app = await resolveApp(deps, appId);
  const build = await findBuild(deps, app, buildNumber);
  if (build.expired) throw new Error(`Build ${build.version} has already expired.`);
  const preview = await prepareChange({
    op: opFor('PATCH', '/v1/builds/{id}'),
    pathParams: { id: build.id },
    body: { data: { type: 'builds', id: build.id, attributes: { expired: true } } },
    deps,
  });
  return {
    build: build.version,
    uploadedLocal: toLocalTime(build.uploadedDate),
    warning: 'Expiring cannot be undone: testers lose this build at once. It does not affect the App Store or a version already using it in review.',
    ...preview,
  };
}
