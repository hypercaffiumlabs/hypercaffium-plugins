// Apple release workflows: look at a release, edit it, submit it. Everything that changes data
// goes through prepareChange / preparePlan, so every action is a previewed, ticketed, audited change.
// Network access is injected (deps.get), so all of this is testable offline.
import { EDITABLE_VERSION_STATES } from './rules.js';
import { findOperation, preparePlan } from './plans.js';
import { prepareChange } from './writes.js';
import { toLocalTime } from './util.js';

export const flat = (r) => (r ? { id: r.id, type: r.type, ...(r.attributes || {}) } : null);
export const list = (body) => (body?.data || []).map(flat);
const stateOf = (v) => v.appStoreState || v.appVersionState || 'UNKNOWN';
const newestFirst = (a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || ''));
const qs = (o) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

const GONE = new Set(['REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE', 'NOT_APPLICABLE']);
const SUBMISSION_OPEN = ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES'];

const opFor = (method, path) => {
  const op = findOperation(method, path);
  if (!op) throw new Error(`Apple's API has no ${method} ${path}.`);
  return op;
};

// ---- finding things --------------------------------------------------------

export async function resolveApp(deps, appId) {
  if (appId) return appId;
  const apps = list(await deps.get('/v1/apps?limit=50'));
  if (apps.length !== 1) {
    throw new Error(`The account has ${apps.length} apps; pass appId. Options: ${apps.map((a) => `${a.name}=${a.id}`).join(', ')}`);
  }
  return apps[0].id;
}

// mode: 'editable' (default; the draft you can change), 'live', or 'any' (editable, else in flight, else live)
export async function findVersion(deps, { appId, version, platform = 'IOS', mode = 'editable' }) {
  const all = list(await deps.get(`/v1/apps/${encodeURIComponent(appId)}/appStoreVersions${qs({ limit: 40 })}`))
    .filter((v) => v.platform === platform && !GONE.has(stateOf(v)))
    .sort(newestFirst);
  if (version) {
    const hit = all.find((v) => v.versionString === version);
    if (!hit) throw new Error(`No ${platform} version "${version}". Versions: ${all.map((v) => `${v.versionString} (${stateOf(v)})`).join(', ') || 'none'}.`);
    return hit;
  }
  const editable = all.find((v) => EDITABLE_VERSION_STATES.has(stateOf(v)));
  const live = all.find((v) => stateOf(v) === 'READY_FOR_SALE');
  const inFlight = all.find((v) => !EDITABLE_VERSION_STATES.has(stateOf(v)) && stateOf(v) !== 'READY_FOR_SALE');
  const pick = mode === 'live' ? live : mode === 'any' ? editable || inFlight || live : editable;
  if (!pick) {
    throw new Error(
      mode === 'editable'
        ? 'There is no editable (draft) version. Create one with asc_create_version first.'
        : 'No matching version found.',
    );
  }
  return pick;
}

// ---- overview + pre-flight -------------------------------------------------

const present = (s) => typeof s === 'string' && s.trim().length > 0;

export async function releaseOverview(deps, { appId, version, platform = 'IOS' }) {
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'any' });
  const body = await deps.get(
    `/v1/appStoreVersions/${encodeURIComponent(v.id)}${qs({ include: 'build,appStoreVersionLocalizations,appStoreReviewDetail,appStoreVersionPhasedRelease' })}`,
  );
  const inc = body.included || [];
  const of = (t) => inc.filter((i) => i.type === t).map(flat);
  const build = of('builds')[0] || null;
  const locs = of('appStoreVersionLocalizations');
  const review = of('appStoreReviewDetails')[0] || null;
  const phased = of('appStoreVersionPhasedReleases')[0] || null;

  // Screenshots per locale
  const locales = [];
  for (const l of locs) {
    let sets = [];
    try {
      const sb = await deps.get(`/v1/appStoreVersionLocalizations/${encodeURIComponent(l.id)}/appScreenshotSets${qs({ include: 'appScreenshots', limit: 50 })}`);
      const shots = (sb.included || []).filter((i) => i.type === 'appScreenshots');
      sets = (sb.data || []).map((s) => ({
        displayType: s.attributes?.screenshotDisplayType,
        count: (s.relationships?.appScreenshots?.data || []).filter((r) => shots.some((x) => x.id === r.id)).length ||
          (s.relationships?.appScreenshots?.data || []).length,
      }));
    } catch {
      sets = null;
    }
    locales.push({
      locale: l.locale,
      localizationId: l.id,
      hasDescription: present(l.description),
      hasKeywords: present(l.keywords),
      hasSupportUrl: present(l.supportUrl),
      hasWhatsNew: present(l.whatsNew),
      whatsNew: l.whatsNew || null,
      screenshotSets: sets,
    });
  }

  // Is there an open review submission for this app?
  let submissions = [];
  try {
    submissions = list(
      await deps.get(`/v1/apps/${encodeURIComponent(app)}/reviewSubmissions${qs({ 'filter[state]': SUBMISSION_OPEN.join(','), 'filter[platform]': platform, limit: 10 })}`),
    );
  } catch {
    submissions = [];
  }

  // A first release has no "What's New"; every later one needs it.
  const allVersions = list(await deps.get(`/v1/apps/${encodeURIComponent(app)}/appStoreVersions${qs({ limit: 40 })}`));
  const hasPrevious = allVersions.some((x) => x.id !== v.id && ['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION'].includes(stateOf(x)));

  const state = stateOf(v);
  const checks = [];
  const add = (check, ok, detail, severity = 'blocking') => checks.push({ check, ok, severity: ok ? 'ok' : severity, detail });
  add('Version is an editable draft', EDITABLE_VERSION_STATES.has(state), `state is ${state}`, 'info');
  add('A build is attached', Boolean(build), build ? `build ${build.version}` : 'no build chosen (use asc_attach_build)');
  if (build) {
    add('Build finished processing', build.processingState === 'VALID', `processing state ${build.processingState}`);
    add('Build has not expired', build.expired !== true, build.expired ? 'expired' : 'ok');
    add('Export compliance answered', build.usesNonExemptEncryption !== null && build.usesNonExemptEncryption !== undefined,
      build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined ? 'usesNonExemptEncryption is not set on the build' : 'answered');
  }
  add('At least one localization', locales.length > 0, `${locales.length} locale(s)`);
  for (const l of locales) {
    add(`${l.locale}: description`, l.hasDescription, l.hasDescription ? 'present' : 'missing');
    add(`${l.locale}: keywords`, l.hasKeywords, l.hasKeywords ? 'present' : 'missing');
    add(`${l.locale}: support URL`, l.hasSupportUrl, l.hasSupportUrl ? 'present' : 'missing');
    if (hasPrevious) add(`${l.locale}: release notes (What's New)`, l.hasWhatsNew, l.hasWhatsNew ? 'present' : 'missing (use asc_set_release_notes)');
    const n = (l.screenshotSets || []).reduce((s, x) => s + (x.count || 0), 0);
    add(`${l.locale}: screenshots`, l.screenshotSets === null ? true : n > 0, l.screenshotSets === null ? 'could not check' : `${n} screenshot(s)`);
  }
  if (review) {
    add('Review contact details', present(review.contactEmail) && present(review.contactPhone), present(review.contactEmail) && present(review.contactPhone) ? 'present' : 'contact email/phone missing');
    if (review.demoAccountRequired) add('Demo account provided', present(review.demoAccountName) && present(review.demoAccountPassword), 'demo account is required');
  } else {
    add('Review details exist', false, 'no App Review details on this version');
  }
  add('No review submission already open', submissions.length === 0, submissions.length ? `submission ${submissions[0].id} is ${submissions[0].state}` : 'none', 'blocking');

  const problems = checks.filter((c) => !c.ok && c.severity === 'blocking').map((c) => `${c.check}: ${c.detail}`);
  return {
    app,
    version: { id: v.id, versionString: v.versionString, platform: v.platform, state, releaseType: v.releaseType, createdLocal: toLocalTime(v.createdDate) },
    build: build ? { build: build.version, processingState: build.processingState, expired: build.expired, uploadedLocal: toLocalTime(build.uploadedDate) } : null,
    locales,
    reviewDetails: review
      ? { contactName: [review.contactFirstName, review.contactLastName].filter(Boolean).join(' '), contactEmail: review.contactEmail, contactPhoneSet: present(review.contactPhone), demoAccountRequired: Boolean(review.demoAccountRequired), notesSet: present(review.notes) }
      : null,
    phasedRelease: phased ? { id: phased.id, state: phased.phasedReleaseState, day: phased.currentDayNumber } : null,
    openSubmissions: submissions.map((s) => ({ id: s.id, state: s.state, submittedLocal: toLocalTime(s.submittedDate) })),
    checks,
    readyToSubmit: EDITABLE_VERSION_STATES.has(state) && problems.length === 0,
    problems,
  };
}

// ---- editing release text --------------------------------------------------

const LIMITS = { description: 4000, whatsNew: 4000, keywords: 100, promotionalText: 170, marketingUrl: 255, supportUrl: 255 };
const TEXT_FIELDS = Object.keys(LIMITS);

export function checkListingFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw new Error(`Provide at least one field to change: ${TEXT_FIELDS.join(', ')}.`);
  for (const [k, v] of entries) {
    if (!TEXT_FIELDS.includes(k)) throw new Error(`Unknown field "${k}". Allowed: ${TEXT_FIELDS.join(', ')}.`);
    if (typeof v !== 'string') throw new Error(`"${k}" must be text.`);
    if (v.length > LIMITS[k]) throw new Error(`"${k}" is ${v.length} characters; Apple allows at most ${LIMITS[k]}.`);
  }
  return Object.fromEntries(entries);
}

export async function prepareListingEdit(deps, { appId, version, locale = 'en-US', fields, platform = 'IOS' }) {
  const attrs = checkListingFields(fields);
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'editable' });
  const locs = list(await deps.get(`/v1/appStoreVersions/${encodeURIComponent(v.id)}/appStoreVersionLocalizations${qs({ limit: 50 })}`));
  const loc = locs.find((l) => l.locale === locale);
  const context = { version: v.versionString, versionState: stateOf(v), locale };
  if (loc) {
    const op = opFor('PATCH', '/v1/appStoreVersionLocalizations/{id}');
    const preview = await prepareChange({
      op,
      pathParams: { id: loc.id },
      body: { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: attrs } },
      deps,
    });
    return { ...context, ...preview };
  }
  const op = opFor('POST', '/v1/appStoreVersionLocalizations');
  const preview = await prepareChange({
    op,
    body: {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale, ...attrs },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } },
      },
    },
    deps,
  });
  return { ...context, creatingNewLocale: true, existingLocales: locs.map((l) => l.locale), ...preview };
}

// ---- build, versions -------------------------------------------------------

export async function prepareAttachBuild(deps, { appId, version, buildNumber, platform = 'IOS' }) {
  if (!buildNumber) throw new Error('Pass buildNumber (the number EAS shows, e.g. "57").');
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'editable' });
  const builds = list(await deps.get(`/v1/builds${qs({ 'filter[app]': app, 'filter[version]': String(buildNumber), limit: 5 })}`));
  const b = builds[0];
  if (!b) throw new Error(`No build "${buildNumber}" found for this app. Check asc_list_builds (EAS may still be uploading it).`);
  if (b.processingState !== 'VALID') throw new Error(`Build ${buildNumber} is ${b.processingState}, not VALID yet. Wait for processing to finish.`);
  if (b.expired) throw new Error(`Build ${buildNumber} has expired and cannot be attached.`);
  const preview = await prepareChange({
    op: opFor('PATCH', '/v1/appStoreVersions/{id}/relationships/build'),
    pathParams: { id: v.id },
    body: { data: { type: 'builds', id: b.id } },
    deps,
  });
  return { version: v.versionString, versionState: stateOf(v), build: { number: b.version, processingState: b.processingState, uploadedLocal: toLocalTime(b.uploadedDate) }, ...preview };
}

export async function prepareCreateVersion(deps, { appId, versionString, releaseType = 'AFTER_APPROVAL', platform = 'IOS' }) {
  if (!/^\d+(\.\d+){0,3}$/.test(versionString || '')) throw new Error('versionString must look like 1.1.4.');
  const app = await resolveApp(deps, appId);
  const all = list(await deps.get(`/v1/apps/${encodeURIComponent(app)}/appStoreVersions${qs({ limit: 40 })}`)).filter((v) => v.platform === platform);
  if (all.some((v) => v.versionString === versionString && !GONE.has(stateOf(v)))) {
    throw new Error(`Version ${versionString} already exists (${stateOf(all.find((v) => v.versionString === versionString))}).`);
  }
  const draft = all.find((v) => EDITABLE_VERSION_STATES.has(stateOf(v)));
  if (draft) throw new Error(`There is already an editable version (${draft.versionString}, ${stateOf(draft)}). Edit that one, or submit it first.`);
  const preview = await prepareChange({
    op: opFor('POST', '/v1/appStoreVersions'),
    body: {
      data: {
        type: 'appStoreVersions',
        attributes: { platform, versionString, releaseType },
        relationships: { app: { data: { type: 'apps', id: app } } },
      },
    },
    deps,
  });
  return { ...preview, note: 'Apple copies the previous version\'s text into the new draft. Set release notes next with asc_set_release_notes.' };
}

// ---- submit / cancel / release ---------------------------------------------

export async function prepareSubmit(deps, { appId, version, platform = 'IOS' }) {
  const overview = await releaseOverview(deps, { appId, version, platform });
  const summary = {
    version: overview.version.versionString,
    state: overview.version.state,
    build: overview.build,
    locales: overview.locales.map((l) => l.locale),
    releaseType: overview.version.releaseType,
    phasedRelease: overview.phasedRelease,
  };
  if (!EDITABLE_VERSION_STATES.has(overview.version.state)) {
    return {
      allowed: false,
      ready: false,
      summary,
      problems: [
        `Version ${summary.version} is ${summary.state}, not an editable draft, so there is nothing to submit. Create the next version with asc_create_version, then set its build and release notes.`,
      ],
      note: 'Nothing was submitted.',
    };
  }
  if (!overview.readyToSubmit) {
    return { allowed: false, ready: false, summary, problems: overview.problems, note: 'Fix these first. Nothing was submitted.', checks: overview.checks.filter((c) => !c.ok) };
  }
  const existingDraft = overview.openSubmissions.find((s) => s.state === 'READY_FOR_REVIEW');
  const steps = [];
  let subRef;
  if (existingDraft) {
    subRef = existingDraft.id;
  } else {
    steps.push({
      label: 'Create the review submission',
      method: 'POST',
      path: '/v1/reviewSubmissions',
      body: { data: { type: 'reviewSubmissions', attributes: { platform }, relationships: { app: { data: { type: 'apps', id: overview.app } } } } },
    });
    subRef = '{{0.id}}';
  }
  steps.push({
    label: `Add version ${summary.version} to the submission`,
    method: 'POST',
    path: '/v1/reviewSubmissionItems',
    body: {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: subRef } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: overview.version.id } },
        },
      },
    },
  });
  steps.push({
    label: 'Submit for App Review',
    method: 'PATCH',
    path: '/v1/reviewSubmissions/{id}',
    pathParams: { id: subRef },
    body: { data: { type: 'reviewSubmissions', id: subRef, attributes: { submitted: true } } },
  });
  const plan = await preparePlan({ title: `Submit ${summary.version} (build ${overview.build.build}) for App Review`, steps, deps });
  return {
    ...plan,
    ready: true,
    summary,
    afterApproval:
      summary.releaseType === 'AFTER_APPROVAL'
        ? 'This version is set to release AUTOMATICALLY as soon as Apple approves it.'
        : `Release type is ${summary.releaseType}: it will NOT go live automatically.`,
  };
}

export async function prepareCancelSubmission(deps, { appId, platform = 'IOS' }) {
  const app = await resolveApp(deps, appId);
  const subs = list(await deps.get(`/v1/apps/${encodeURIComponent(app)}/reviewSubmissions${qs({ 'filter[state]': 'WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,READY_FOR_REVIEW', 'filter[platform]': platform, limit: 10 })}`));
  const s = subs[0];
  if (!s) throw new Error('There is no open review submission to cancel.');
  const preview = await prepareChange({
    op: opFor('PATCH', '/v1/reviewSubmissions/{id}'),
    pathParams: { id: s.id },
    body: { data: { type: 'reviewSubmissions', id: s.id, attributes: { canceled: true } } },
    deps,
  });
  return { submission: { id: s.id, state: s.state, submittedLocal: toLocalTime(s.submittedDate) }, ...preview };
}

export async function preparePhasedRelease(deps, { appId, version, action, platform = 'IOS' }) {
  const ACTIONS = { enable: 'INACTIVE', pause: 'PAUSED', resume: 'ACTIVE', complete: 'COMPLETE' };
  if (!ACTIONS[action]) throw new Error(`action must be one of: ${Object.keys(ACTIONS).join(', ')}.`);
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'any' });
  let phased = null;
  try {
    const r = await deps.get(`/v1/appStoreVersions/${encodeURIComponent(v.id)}/appStoreVersionPhasedRelease`);
    phased = r?.data ? flat(r.data) : null;
  } catch {
    phased = null;
  }
  const context = { version: v.versionString, versionState: stateOf(v), phasedRelease: phased ? { id: phased.id, state: phased.phasedReleaseState, day: phased.currentDayNumber } : null };
  if (action === 'enable') {
    if (phased) throw new Error(`Phased release is already set up (state ${phased.phasedReleaseState}).`);
    const preview = await prepareChange({
      op: opFor('POST', '/v1/appStoreVersionPhasedReleases'),
      body: { data: { type: 'appStoreVersionPhasedReleases', attributes: { phasedReleaseState: 'INACTIVE' }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } },
      deps,
    });
    return { ...context, ...preview, note: 'It starts ramping (7-day schedule) only once the version is released.' };
  }
  if (!phased) throw new Error('This version has no phased release. Use action "enable" before release.');
  const preview = await prepareChange({
    op: opFor('PATCH', '/v1/appStoreVersionPhasedReleases/{id}'),
    pathParams: { id: phased.id },
    body: { data: { type: 'appStoreVersionPhasedReleases', id: phased.id, attributes: { phasedReleaseState: ACTIONS[action] } } },
    deps,
  });
  return { ...context, ...preview };
}

export async function prepareReleaseNow(deps, { appId, version, platform = 'IOS' }) {
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'any' });
  if (stateOf(v) !== 'PENDING_DEVELOPER_RELEASE') {
    throw new Error(`Version ${v.versionString} is ${stateOf(v)}. Only a version that is PENDING_DEVELOPER_RELEASE (approved, waiting for you) can be released.`);
  }
  const preview = await prepareChange({
    op: opFor('POST', '/v1/appStoreVersionReleaseRequests'),
    body: { data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } },
    deps,
  });
  return { version: v.versionString, ...preview, warning: 'This makes the version available to users on the App Store.' };
}
