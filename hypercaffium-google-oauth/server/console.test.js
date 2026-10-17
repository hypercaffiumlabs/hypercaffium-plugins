import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, ACTIONS, pageUrl, consolePlan, compareObservation } from './console.js';

const P = 'my-project-123';

test('pageUrl builds the exact console address', () => {
  assert.equal(pageUrl('audience', P), 'https://console.cloud.google.com/auth/audience?project=my-project-123');
  assert.throws(() => pageUrl('nope', P), /Unknown/);
});

test('every console action points at a known page', () => {
  for (const [name, a] of Object.entries(ACTIONS)) {
    if (a.mode === 'console') assert.ok(PAGES[a.page], `${name} needs a page`);
  }
  assert.equal(ACTIONS.enable_api.mode, 'gcloud');
  assert.equal(ACTIONS.sign_in_account.mode, 'local');
});

test('publish plan', () => {
  const p = consolePlan('publish', P, {});
  assert.deepEqual(p.expected, { publishingStatus: 'In production' });
  assert.ok(p.manual[0].includes(pageUrl('audience', P)));
  assert.ok(p.steps.length > 0);
});

test('plan expectations per action', () => {
  assert.deepEqual(consolePlan('add_scopes', P, { scopes: ['a'] }).expected, { scopesInclude: ['a'] });
  assert.deepEqual(consolePlan('remove_scopes', P, { scopes: ['a'] }).expected, { scopesExclude: ['a'] });
  assert.deepEqual(consolePlan('create_client', P, { name: 'n', clientType: 'desktop' }).expected, { clientNamed: 'n', clientType: 'desktop' });
  assert.deepEqual(consolePlan('delete_client', P, { name: 'n' }).expected, { clientAbsent: 'n' });
  assert.deepEqual(consolePlan('add_test_user', P, { email: 'a@b.c' }).expected, { testUsersInclude: ['a@b.c'] });
  assert.deepEqual(consolePlan('set_user_type', P, { userType: 'Internal' }).expected, { userType: 'Internal' });
  assert.deepEqual(consolePlan('back_to_testing', P, {}).expected, { publishingStatus: 'Testing' });
  assert.deepEqual(consolePlan('set_branding', P, { fields: { appName: 'X' } }).expected, { appName: 'X' });
});

test('plans reject bad actions and params', () => {
  assert.throws(() => consolePlan('enable_api', P, { api: 'x' }), /not a console action/);
  assert.throws(() => consolePlan('sign_in_account', P, {}), /not a console action/);
  assert.throws(() => consolePlan('bogus', P, {}), /Unknown/);
  assert.throws(() => consolePlan('add_scopes', P, {}), /scopes/);
  assert.throws(() => consolePlan('create_client', P, { name: 'n', clientType: 'mobile' }), /clientType/);
});

test('plans contain no em dashes', () => {
  const all = JSON.stringify([
    consolePlan('publish', P, {}), consolePlan('back_to_testing', P, {}),
    consolePlan('set_branding', P, { fields: { appName: 'X', supportEmail: 'a@b.c' } }),
  ]);
  assert.ok(!all.includes('—'));
});

test('compareObservation', () => {
  let r = compareObservation({ scopesInclude: ['a', 'b'] }, { scopes: ['a'] });
  assert.equal(r.match, false);
  assert.ok(r.differences.join(' ').includes('b'));
  assert.deepEqual(compareObservation({ scopesInclude: ['a'] }, { scopes: ['a', 'c'] }), { match: true, differences: [] });
  assert.equal(compareObservation({ publishingStatus: 'Testing' }, {}).match, false);
  assert.equal(compareObservation({ publishingStatus: 'Testing' }, { publishingStatus: 'In production' }).match, false);
  assert.equal(compareObservation({ scopesExclude: ['a'] }, { scopes: ['a'] }).match, false);
  assert.equal(compareObservation({ scopesExclude: ['a'] }, { scopes: ['b'] }).match, true);
  const c = { clients: [{ name: 'n', type: 'Desktop' }] };
  assert.equal(compareObservation({ clientNamed: 'n', clientType: 'desktop' }, c).match, true);
  assert.equal(compareObservation({ clientNamed: 'n', clientType: 'web' }, c).match, false);
  assert.equal(compareObservation({ clientAbsent: 'n' }, c).match, false);
  assert.equal(compareObservation({ clientAbsent: 'n' }, { clients: [] }).match, true);
  assert.equal(compareObservation({ clientAbsent: 'n' }, {}).match, false);
});

test('normalizeScope handles short, elided and full forms', async () => {
  const { normalizeScope } = await import('./console.js');
  const full = 'https://www.googleapis.com/auth/gmail.modify';
  assert.equal(normalizeScope('…/auth/gmail.modify'), full);
  assert.equal(normalizeScope(' .../auth/gmail.modify '), full);
  assert.equal(normalizeScope(full), full);
  assert.equal(normalizeScope('email'), 'https://www.googleapis.com/auth/userinfo.email');
  assert.equal(normalizeScope('profile'), 'https://www.googleapis.com/auth/userinfo.profile');
  assert.equal(normalizeScope('openid'), 'openid');
});

test('compareObservation: scope forms agree on both sides', () => {
  const full = 'https://www.googleapis.com/auth/gmail.modify';
  assert.equal(compareObservation({ scopesInclude: [full, 'email'] }, { scopes: ['…/auth/gmail.modify', 'https://www.googleapis.com/auth/userinfo.email'] }).match, true);
  assert.equal(compareObservation({ scopesExclude: [full] }, { scopes: ['.../auth/gmail.modify'] }).match, false);
});

test('compareObservation: clients listed as plain strings', () => {
  assert.equal(compareObservation({ clientAbsent: 'n' }, { clients: ['n'] }).match, false);
  assert.equal(compareObservation({ clientAbsent: 'n' }, { clients: ['other'] }).match, true);
  assert.equal(compareObservation({ clientNamed: 'n' }, { clients: ['n'] }).match, true);
});
