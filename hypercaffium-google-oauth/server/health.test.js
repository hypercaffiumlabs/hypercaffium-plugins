import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkAccounts, evaluateConsole } from './health.js';

const RT = 'REFRESH-TOKEN-XYZ';
const SECRET = 'CLIENT-SECRET-ABC';
const ACCESS = 'ACCESS-TOKEN-QQQ';
const SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.modify'];

function setup({ accounts = ['a@x.com', 'b@x.com'], tokens = accounts } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
  fs.mkdirSync(path.join(home, 'tool'));
  fs.writeFileSync(path.join(home, 'tool', '.gauth.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: SECRET } }));
  fs.writeFileSync(path.join(home, 'tool', '.accounts.json'), JSON.stringify({ accounts: accounts.map((e) => ({ email: e, account_type: 'p' })) }));
  for (const e of tokens) fs.writeFileSync(path.join(home, 'tool', `.oauth2.${e}.json`), JSON.stringify({ refresh_token: RT }));
  const recipe = {
    scopes: SCOPES, clientType: 'desktop', clientFile: '{home}/tool/.gauth.json',
    accountsFile: { path: '{home}/tool/.accounts.json', listKey: 'accounts', entry: { email: '{email}', account_type: '{accountType}' } },
    tokens: { path: '{home}/tool/.oauth2.{email}.json', refreshTokenField: 'refresh_token' },
  };
  return { home, recipe };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('ok with missing scopes computed', async () => {
  const { home, recipe } = setup();
  const f = async (url) => (url.includes('tokeninfo')
    ? json(200, { scope: 'openid https://www.googleapis.com/auth/userinfo.email' })
    : json(200, { access_token: ACCESS }));
  const r = await checkAccounts({ recipe }, { fetch: f, fs, home });
  assert.equal(r.accounts.length, 2);
  assert.equal(r.accounts[0].status, 'ok');
  assert.deepEqual(r.accounts[0].missingScopes, ['https://www.googleapis.com/auth/gmail.modify']);
  assert.match(r.accounts[0].note, /gmail\.modify/);
});

test('short email scope counts as userinfo.email', async () => {
  const { home, recipe } = setup({ accounts: ['a@x.com'] });
  const f = async (url) => (url.includes('tokeninfo')
    ? json(200, { scope: 'openid email https://www.googleapis.com/auth/gmail.modify' }) : json(200, { access_token: ACCESS }));
  const r = await checkAccounts({ recipe }, { fetch: f, fs, home });
  assert.deepEqual(r.accounts[0].missingScopes, []);
});

test('sends the refresh request in the right form', async () => {
  const { home, recipe } = setup({ accounts: ['a@x.com'] });
  let seen;
  const f = async (url, opts) => {
    if (url.includes('tokeninfo')) return json(200, { scope: 'openid' });
    seen = { url, opts };
    return json(200, { access_token: ACCESS });
  };
  await checkAccounts({ recipe }, { fetch: f, fs, home });
  assert.equal(seen.url, 'https://oauth2.googleapis.com/token');
  assert.equal(seen.opts.method, 'POST');
  const p = new URLSearchParams(seen.opts.body);
  assert.equal(p.get('grant_type'), 'refresh_token');
  assert.equal(p.get('refresh_token'), RT);
  assert.equal(p.get('client_id'), 'cid');
  assert.equal(p.get('client_secret'), SECRET);
});

test('invalid_grant gives needs-sign-in and the next account is still checked', async () => {
  const { home, recipe } = setup();
  let n = 0;
  const f = async (url) => {
    if (url.includes('tokeninfo')) return json(200, { scope: SCOPES.join(' ') });
    return n++ === 0 ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: ACCESS });
  };
  const r = await checkAccounts({ recipe }, { fetch: f, fs, home });
  assert.equal(r.accounts[0].status, 'needs-sign-in');
  assert.equal(r.accounts[1].status, 'ok');
});

test('missing token file, bad json, no field, invalid email', async () => {
  const { home, recipe } = setup({ accounts: ['a@x.com', 'b@x.com', 'c@x.com'], tokens: ['b@x.com', 'c@x.com'] });
  fs.writeFileSync(path.join(home, 'tool', '.oauth2.b@x.com.json'), 'nope');
  fs.writeFileSync(path.join(home, 'tool', '.oauth2.c@x.com.json'), '{}');
  const f = async () => { throw new Error('should not be called'); };
  const r = await checkAccounts({ recipe, emails: ['a@x.com', 'b@x.com', 'c@x.com', '../evil'] }, { fetch: f, fs, home });
  assert.deepEqual(r.accounts.map((a) => a.status), ['missing', 'unreadable', 'unreadable', 'unreadable']);
});

test('network failure is unreadable, never ok', async () => {
  const { home, recipe } = setup({ accounts: ['a@x.com'] });
  const f = async () => { throw new Error(`boom ${RT}`); };
  const r = await checkAccounts({ recipe }, { fetch: f, fs, home });
  assert.equal(r.accounts[0].status, 'unreadable');
  assert.equal(r.accounts[0].note, 'Could not reach Google');
});

test('bad client file makes accounts unreadable', async () => {
  const { home, recipe } = setup({ accounts: ['a@x.com'] });
  fs.writeFileSync(path.join(home, 'tool', '.gauth.json'), '{}');
  const r = await checkAccounts({ recipe }, { fetch: async () => json(200, {}), fs, home });
  assert.equal(r.accounts[0].status, 'unreadable');
});

test('no accounts file and no emails is a plain error', async () => {
  const { home, recipe } = setup();
  delete recipe.accountsFile;
  await assert.rejects(checkAccounts({ recipe }, { fs, home }), /pass the email/);
});

test('no output contains tokens or the secret, even with hostile response bodies', async () => {
  const { home, recipe } = setup({ accounts: ['a@x.com', 'b@x.com', 'c@x.com'] });
  let n = 0;
  const f = async (url) => {
    if (url.includes('tokeninfo')) return json(500, { error: RT + SECRET + ACCESS });
    n += 1;
    if (n === 1) return json(401, { error: RT });
    if (n === 2) return json(500, { error: SECRET });
    return json(200, { access_token: ACCESS });
  };
  const r = await checkAccounts({ recipe }, { fetch: f, fs, home });
  const out = JSON.stringify(r);
  for (const s of [RT, SECRET, ACCESS]) assert.ok(!out.includes(s));
  assert.equal(r.accounts[0].status, 'needs-sign-in');
});

const gm = { scopes: SCOPES, clientType: 'desktop' };
test('console: nothing observed is unknown, never ok', () => {
  const { items } = evaluateConsole({ recipe: gm, observed: {} });
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.status === 'unknown'));
  assert.match(items.find((i) => i.check === 'App verification').detail, /restricted/);
});

test('console: Testing is a problem mentioning 7 days; production ok', () => {
  const t = evaluateConsole({ recipe: gm, observed: { publishingStatus: 'Testing' } }).items[0];
  assert.equal(t.status, 'problem');
  assert.match(t.detail, /7 days/);
  assert.equal(evaluateConsole({ recipe: gm, observed: { publishingStatus: 'In production' } }).items[0].status, 'ok');
});

test('console: scopes, client and verification evaluated', () => {
  const o = evaluateConsole({ recipe: gm, observed: { scopes: ['openid'], clients: [{ type: 'web' }], verificationStatus: 'Unverified' } }).items;
  const by = Object.fromEntries(o.map((i) => [i.check, i]));
  assert.equal(by.Scopes.status, 'problem');
  assert.equal(by['Sign-in client'].status, 'problem');
  assert.equal(by['App verification'].status, 'problem');
  const good = evaluateConsole({ recipe: gm, observed: { scopes: SCOPES, clients: ['desktop'], verificationStatus: 'Verified' } }).items;
  assert.ok(good.filter((i) => i.check !== 'Publishing status').every((i) => i.status === 'ok'));
});

test('console: no gmail scope means no verification item', () => {
  const { items } = evaluateConsole({ recipe: { scopes: ['openid'], clientType: 'web' }, observed: {} });
  assert.ok(!items.some((i) => i.check === 'App verification'));
});

test('console: client type compares case-insensitively and scopes accept console forms', () => {
  const o = evaluateConsole({
    recipe: gm,
    observed: { scopes: ['openid', 'email', '…/auth/gmail.modify'], clients: [{ name: 'c', type: 'Desktop' }] },
  }).items;
  const by = Object.fromEntries(o.map((i) => [i.check, i]));
  assert.equal(by['Sign-in client'].status, 'ok');
  assert.equal(by.Scopes.status, 'ok');
});
