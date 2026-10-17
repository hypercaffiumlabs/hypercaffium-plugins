// Health check: asks Google (not guesses) whether each signed-in account still works and which
// scopes the login really has, and judges what Claude observed on the Cloud Console pages.
// Read-only: it never writes the tool's files, and no token or secret ever appears in a result.
import nodeFs from 'node:fs';
import os from 'node:os';
import { expand } from './recipes.js';
import { normalizeScope } from './console.js';

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const canon = normalizeScope;
const KEY_FOR_TYPE = { desktop: 'installed', web: 'web' };

const fail = (email, status, note) => ({ email, status, note });
const readJson = (fs, file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function defaultEmails(recipe, vars, fs) {
  const af = recipe.accountsFile;
  if (!af) throw new Error('This recipe has no accounts file, so pass the email addresses to check.');
  const field = Object.keys(af.entry || {}).find((k) => af.entry[k] === '{email}');
  if (!field) throw new Error('This recipe accounts file has no email field, so pass the email addresses to check.');
  let list;
  try {
    list = readJson(fs, expand(af.path, vars))[af.listKey];
  } catch {
    throw new Error('Could not read the accounts file, so pass the email addresses to check.');
  }
  if (!Array.isArray(list)) throw new Error('The accounts file has no account list, so pass the email addresses to check.');
  return list.map((e) => (e && typeof e === 'object' ? e[field] : undefined));
}

function readClient(recipe, vars, fs) {
  try {
    const raw = readJson(fs, expand(recipe.clientFile, vars));
    const c = raw && raw[KEY_FOR_TYPE[recipe.clientType]];
    if (c && typeof c.client_id === 'string' && typeof c.client_secret === 'string') return c;
  } catch { /* reported by the caller as a client file problem */ }
  return null;
}

async function checkOne(email, { recipe, vars, client, fs, fetchFn }) {
  if (typeof email !== 'string' || !EMAIL.test(email)) {
    return fail(String(email), 'unreadable', 'That is not a valid email address, so it was not checked.');
  }
  if (!client) return fail(email, 'unreadable', 'The sign-in client file is missing or not in the expected shape.');

  const tokenFile = expand(recipe.tokens.path, { ...vars, email });
  if (!fs.existsSync(tokenFile)) return fail(email, 'missing', 'No saved login was found for this account.');
  let refreshToken;
  try {
    refreshToken = readJson(fs, tokenFile)?.[recipe.tokens.refreshTokenField];
  } catch {
    return fail(email, 'unreadable', 'The saved login file could not be read.');
  }
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    return fail(email, 'unreadable', 'The saved login has no refresh token.');
  }

  try {
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    let body = null;
    try { body = await res.json(); } catch { /* the verdict does not need the body */ }
    if (!res.ok) {
      if (res.status === 400 || res.status === 401 || body?.error === 'invalid_grant') {
        return fail(email, 'needs-sign-in', `Google rejected the saved login (HTTP ${res.status}). Sign this account in again.`);
      }
      return fail(email, 'unreadable', `Google could not refresh the login (HTTP ${res.status}).`);
    }
    const accessToken = body?.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      return fail(email, 'unreadable', 'Google did not return an access token.');
    }

    const info = await fetchFn(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
    if (!info.ok) return fail(email, 'unreadable', `Google could not report the scopes of the login (HTTP ${info.status}).`);
    let infoBody = null;
    try { infoBody = await info.json(); } catch { /* handled below */ }
    if (!infoBody || typeof infoBody.scope !== 'string') {
      return fail(email, 'unreadable', 'Google did not report which scopes the login has.');
    }
    const scopes = infoBody.scope.split(/\s+/).filter(Boolean);
    const have = new Set(scopes.map(canon));
    const missingScopes = (recipe.scopes || []).filter((s) => !have.has(canon(s)));
    const note = missingScopes.length === 0
      ? 'Sign-in works and has every scope the tool needs.'
      : `Sign-in works but is missing: ${missingScopes.join(', ')}. Sign in again to grant them.`;
    return { email, status: 'ok', scopes, missingScopes, note };
  } catch {
    return fail(email, 'unreadable', 'Could not reach Google');
  }
}

export async function checkAccounts({ recipe, emails } = {}, deps = {}) {
  const fs = deps.fs || nodeFs;
  const fetchFn = deps.fetch || globalThis.fetch;
  const vars = { home: deps.home || os.homedir() };
  const list = emails ?? defaultEmails(recipe, vars, fs);
  const client = readClient(recipe, vars, fs);
  const accounts = [];
  for (const email of list) accounts.push(await checkOne(email, { recipe, vars, client, fs, fetchFn }));
  return { accounts };
}

const item = (check, status, detail) => ({ check, status, detail });

export function evaluateConsole({ recipe, observed } = {}) {
  const obs = observed || {};
  const items = [];

  const pub = typeof obs.publishingStatus === 'string' ? obs.publishingStatus.trim().toLowerCase() : '';
  if (pub === 'in production') {
    items.push(item('Publishing status', 'ok', 'The app is In production, so logins do not expire after 7 days.'));
  } else if (pub === 'testing') {
    items.push(item('Publishing status', 'problem', 'The app is in Testing, so logins expire after 7 days. Publish it to production to stop that.'));
  } else if (pub) {
    items.push(item('Publishing status', 'unknown', `The publishing status was read as "${obs.publishingStatus}", which this check does not recognize.`));
  } else {
    items.push(item('Publishing status', 'unknown', 'The publishing status was not observed on the console page.'));
  }

  if (Array.isArray(obs.scopes)) {
    const have = new Set(obs.scopes.map(canon));
    const missing = (recipe.scopes || []).filter((s) => !have.has(canon(s)));
    items.push(missing.length === 0
      ? item('Scopes', 'ok', 'The console lists every scope the tool needs.')
      : item('Scopes', 'problem', `The console is missing these scopes: ${missing.join(', ')}.`));
  } else {
    items.push(item('Scopes', 'unknown', 'The configured scopes were not observed on the console page.'));
  }

  if (Array.isArray(obs.clients)) {
    const types = obs.clients.map((c) => (typeof c === 'string' ? c : c?.type)).map((t) => String(t || '').toLowerCase());
    items.push(types.includes(String(recipe.clientType).toLowerCase())
      ? item('Sign-in client', 'ok', `A ${recipe.clientType} client exists.`)
      : item('Sign-in client', 'problem', `No ${recipe.clientType} client was found on the console page. Create one.`));
  } else {
    items.push(item('Sign-in client', 'unknown', 'The list of sign-in clients was not observed on the console page.'));
  }

  if ((recipe.scopes || []).some((s) => /gmail\./.test(s))) {
    const v = typeof obs.verificationStatus === 'string' ? obs.verificationStatus.trim().toLowerCase() : '';
    if (!v) {
      items.push(item('App verification', 'unknown',
        'Gmail scopes are restricted. Until Google verifies the app, people see an unverified-app warning and the user cap applies. Verification status was not observed.'));
    } else if (v === 'verified' || v === 'verification approved') {
      items.push(item('App verification', 'ok', 'Google has verified the app.'));
    } else {
      items.push(item('App verification', 'problem',
        `Gmail scopes are restricted and the app is not verified (read as "${obs.verificationStatus}"). The unverified-app warning and user cap apply.`));
    }
  }
  return { items };
}
