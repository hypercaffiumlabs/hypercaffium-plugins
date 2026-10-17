// Google offers no API for the Google Auth Platform screens, so changes there are done in the
// owner's browser. This module holds every page address and visible label in one place and turns
// an action into a "console plan": steps for Claude (Kapture browser tools) plus a manual list for a human.
// Labels not marked verified were not confirmed against the live console and may need a touch-up.

export const PAGES = {
  overview: { path: '/auth/overview', read: ['projectName'] },
  branding: { path: '/auth/branding', read: ['appName', 'supportEmail', 'homepage', 'privacyPolicy', 'termsOfService', 'developerEmail'] },
  audience: { path: '/auth/audience', read: ['publishingStatus', 'userType', 'testUsers'] },
  clients: { path: '/auth/clients', read: ['clients'] },
  scopes: { path: '/auth/scopes', read: ['scopes'] },
  verification: { path: '/auth/verification', read: ['verificationStatus'] },
};

// Verified against the live console on 2026-10-17 (an app In production):
//   /auth/audience: Publishing status, In production, Back to testing, User type, External, Make internal
//   /auth/scopes (shown as "Data Access"): Add or remove scopes, Save
//   /auth/clients: Create client, Delete (client type shows as "Desktop")
//   /auth/branding: App name, User support email, Application privacy policy link,
//     Application terms of service link, Developer contact information
// Not yet seen (only shown in Testing, or inside dialogs that need a click): Testing, Publish app,
// Make external, Test users, Add users, Confirm, Update, Application type, Desktop app,
// Web application, Create, Application home page.
export const LABELS = {
  publishingStatus: 'Publishing status',
  inProduction: 'In production',
  testing: 'Testing',
  publishApp: 'Publish app',
  backToTesting: 'Back to testing',
  userType: 'User type',
  makeInternal: 'Make internal',
  makeExternal: 'Make external',
  testUsers: 'Test users',
  addUsers: 'Add users',
  save: 'Save',
  confirm: 'Confirm',
  addOrRemoveScopes: 'Add or remove scopes',
  update: 'Update',
  createClient: 'Create client',
  applicationType: 'Application type',
  desktopApp: 'Desktop app',
  webApplication: 'Web application',
  create: 'Create',
  delete: 'Delete',
  appName: 'App name',
  userSupportEmail: 'User support email',
  appHomepage: 'Application home page',
  appPrivacyPolicy: 'Application privacy policy link',
  appTermsOfService: 'Application terms of service link',
  developerContact: 'Developer contact information',
};

// Which LABELS entries a person should see on each page. Used by the read-only self-test.
const PAGE_LABEL_KEYS = {
  overview: [],
  branding: ['appName', 'userSupportEmail', 'appHomepage', 'appPrivacyPolicy', 'appTermsOfService', 'developerContact'],
  // "Test users" only appears while an app is in Testing, so it is not expected here.
  audience: ['publishingStatus', 'userType'],
  clients: ['createClient', 'delete'],
  scopes: ['addOrRemoveScopes'],
  verification: [],
};

// The expected visible labels for one console page (single source of truth: LABELS).
export function labelsFor(page) {
  if (!PAGES[page]) throw new Error(`Unknown console page: ${page}`);
  return PAGE_LABEL_KEYS[page].map((k) => LABELS[k]);
}

export const ACTIONS = {
  enable_api: { mode: 'gcloud', feature: 'apis' },
  add_test_user: { mode: 'console', page: 'audience', feature: 'testUsers' },
  set_branding: { mode: 'console', page: 'branding', feature: 'branding' },
  add_scopes: { mode: 'console', page: 'scopes', feature: 'scopes' },
  create_client: { mode: 'console', page: 'clients', feature: 'clients' },
  sign_in_account: { mode: 'local', feature: 'signIns' },
  save_recipe: { mode: 'local', feature: 'signIns' },
  publish: { mode: 'console', page: 'audience', feature: 'publishing' },
  set_user_type: { mode: 'console', page: 'audience', feature: 'publishing' },
  remove_scopes: { mode: 'console', page: 'scopes', feature: 'destructive' },
  delete_client: { mode: 'console', page: 'clients', feature: 'destructive' },
  back_to_testing: { mode: 'console', page: 'audience', feature: 'destructive' },
};

export function pageUrl(page, projectId) {
  if (!PAGES[page]) throw new Error(`Unknown console page: ${page}`);
  return `https://console.cloud.google.com${PAGES[page].path}?project=${encodeURIComponent(projectId)}`;
}

const L = LABELS;
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const isList = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim() !== '');
const isName = (v) => typeof v === 'string' && v.trim() !== '';
const q = (s) => `"${s}"`;
const READ_FIRST = 'Read the page first and confirm it loaded and you are signed in to the right Google account.';
const REREAD = 'Read the page again and report what you now see; do not assume the change worked.';

const BRANDING_FIELDS = {
  appName: L.appName,
  supportEmail: L.userSupportEmail,
  homepage: L.appHomepage,
  privacyPolicy: L.appPrivacyPolicy,
  termsOfService: L.appTermsOfService,
  developerEmail: L.developerContact,
};

// Returns { url, steps, expected, manual } for one console action.
export function consolePlan(action, projectId, params = {}) {
  const def = ACTIONS[action];
  need(def, `Unknown action: ${action}`);
  need(def.mode === 'console', `${action} is not a console action`);
  const url = pageUrl(def.page, projectId);
  let actions;
  let expected;

  switch (action) {
    case 'publish':
      actions = [`Find the ${q(L.publishingStatus)} section.`, `Click ${q(L.publishApp)}.`, `If a confirmation box appears, click ${q(L.confirm)}.`];
      expected = { publishingStatus: L.inProduction };
      break;
    case 'back_to_testing':
      actions = [`Find the ${q(L.publishingStatus)} section.`, `Click ${q(L.backToTesting)}.`, `If a confirmation box appears, click ${q(L.confirm)}.`];
      expected = { publishingStatus: L.testing };
      break;
    case 'set_user_type': {
      need(['External', 'Internal'].includes(params.userType), 'userType must be External or Internal');
      const button = params.userType === 'Internal' ? L.makeInternal : L.makeExternal;
      actions = [`Find the ${q(L.userType)} section.`, `Click ${q(button)}.`, `If a confirmation box appears, click ${q(L.confirm)}.`];
      expected = { userType: params.userType };
      break;
    }
    case 'add_test_user':
      need(isName(params.email) && params.email.includes('@'), 'email is required');
      actions = [`Find the ${q(L.testUsers)} section.`, `Click ${q(L.addUsers)}.`, `Type ${params.email} into the box.`, `Click ${q(L.save)}.`];
      expected = { testUsersInclude: [params.email] };
      break;
    case 'set_branding': {
      const fields = params.fields || {};
      const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
      need(keys.length > 0, 'fields must include at least one branding field');
      for (const k of keys) need(BRANDING_FIELDS[k], `Unknown branding field: ${k}`);
      actions = [...keys.map((k) => `Set the ${q(BRANDING_FIELDS[k])} field to ${fields[k]}.`), `Click ${q(L.save)}.`];
      expected = Object.fromEntries(keys.map((k) => [k, fields[k]]));
      break;
    }
    case 'add_scopes':
      need(isList(params.scopes), 'scopes must be a non-empty list');
      actions = [`Click ${q(L.addOrRemoveScopes)}.`, ...params.scopes.map((s) => `Tick the scope ${s} (use the filter box to find it).`), `Click ${q(L.update)}, then ${q(L.save)}.`];
      expected = { scopesInclude: params.scopes };
      break;
    case 'remove_scopes':
      need(isList(params.scopes), 'scopes must be a non-empty list');
      actions = [`Click ${q(L.addOrRemoveScopes)}.`, ...params.scopes.map((s) => `Untick the scope ${s}.`), `Click ${q(L.update)}, then ${q(L.save)}.`];
      expected = { scopesExclude: params.scopes };
      break;
    case 'create_client': {
      need(isName(params.name), 'name is required');
      need(['desktop', 'web'].includes(params.clientType), 'clientType must be desktop or web');
      const type = params.clientType === 'desktop' ? L.desktopApp : L.webApplication;
      actions = [
        `Click ${q(L.createClient)}.`,
        `Choose ${q(type)} under ${q(L.applicationType)}.`,
        `Type ${params.name} as the name.`,
        `Click ${q(L.create)}.`,
        'Do not copy, read out or store any client secret shown; the owner downloads the client file themselves.',
      ];
      expected = { clientNamed: params.name, clientType: params.clientType };
      break;
    }
    case 'delete_client':
      need(isName(params.name), 'name is required');
      actions = [`Find the client named ${params.name} in the list.`, `Open it and click ${q(L.delete)}.`, `Confirm the deletion with ${q(L.delete)} if asked.`];
      expected = { clientAbsent: params.name };
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  const steps = [READ_FIRST, ...actions, REREAD];
  const manual = [
    `1. Open ${url}`,
    ...actions.map((s, i) => `${i + 2}. ${s}`),
    `${actions.length + 2}. Check the page shows the change.`,
  ];
  return { url, steps, expected, manual };
}

// Puts a scope in one canonical form so "gmail.modify", ".../auth/gmail.modify" and the full URL agree.
export function normalizeScope(s) {
  const t = String(s).trim();
  if (t === 'email') return 'https://www.googleapis.com/auth/userinfo.email';
  if (t === 'profile') return 'https://www.googleapis.com/auth/userinfo.profile';
  return t.replace(/^(?:…|\.{3})\/auth\//, 'https://www.googleapis.com/auth/');
}

// Compares what the plan expected with what Claude observed on the page.
// A missing observed value is always a difference, never a match.
const asClient = (c) => (typeof c === 'string' ? { name: c } : (c || {}));

export function compareObservation(expected, observed) {
  const differences = [];
  const obs = observed || {};
  for (const [key, want] of Object.entries(expected || {})) {
    if (key.endsWith('Include') || key.endsWith('Exclude')) {
      const include = key.endsWith('Include');
      const field = key.slice(0, -7);
      if (!Array.isArray(obs[field])) { differences.push(`${field}: not observed`); continue; }
      if (include) {
        const seen = field === 'scopes' ? obs[field].map(normalizeScope) : obs[field];
        const missing = want.filter((w) => !seen.includes(field === 'scopes' ? normalizeScope(w) : w));
        if (missing.length) differences.push(`${field}: missing ${missing.join(', ')}`);
      } else {
        const seen = field === 'scopes' ? obs[field].map(normalizeScope) : obs[field];
        const present = want.filter((w) => seen.includes(field === 'scopes' ? normalizeScope(w) : w));
        if (present.length) differences.push(`${field}: still present ${present.join(', ')}`);
      }
    } else if (key === 'clientNamed') {
      if (!Array.isArray(obs.clients)) { differences.push('clients: not observed'); continue; }
      const found = obs.clients.map(asClient).find((c) => c.name === want);
      if (!found) differences.push(`client ${want}: not found`);
      else if (expected.clientType && String(found.type || '').toLowerCase() !== expected.clientType.toLowerCase()) {
        differences.push(`client ${want}: type is ${found.type}, expected ${expected.clientType}`);
      }
    } else if (key === 'clientType') {
      continue; // checked together with clientNamed
    } else if (key === 'clientAbsent') {
      if (!Array.isArray(obs.clients)) { differences.push('clients: not observed'); continue; }
      if (obs.clients.map(asClient).some((c) => c.name === want)) differences.push(`client ${want}: still present`);
    } else if (!(key in obs)) {
      differences.push(`${key}: not observed`);
    } else if (obs[key] !== want) {
      differences.push(`${key}: expected ${want}, saw ${obs[key]}`);
    }
  }
  return { match: differences.length === 0, differences };
}
