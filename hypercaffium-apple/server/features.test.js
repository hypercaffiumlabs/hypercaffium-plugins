process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../../shared/features.js';
import { classify, featureFor, setFeatureSource } from './rules.js';
import { loadSpec } from './spec.js';
import { applyChange, prepareChange, TicketStore } from './writes.js';
import { preparePlan } from './plans.js';
import { prepareScreenshots } from './screenshots.js';

const ops = () => loadSpec().operations;
const find = (method, path) => {
  const op = ops().find((o) => o.method === method && o.path === path);
  assert.ok(op, `spec has no ${method} ${path}`);
  return op;
};
const lookupState = (state) => async () => ({ data: { attributes: { appStoreState: state } } });
const tpl = (op) => op.path.replace(/\{[^}]+\}/g, 'x');
const deps = (overrides = {}) => ({
  store: new TicketStore(),
  get: async () => ({ data: { id: '5', type: 'x', attributes: {} } }),
  send: async () => ({ data: { id: '9', type: 'x', attributes: {} } }),
  writesEnabled: () => true,
  ...overrides,
});
const invite = () => find('POST', '/v1/userInvitations');
const inviteBody = {
  data: {
    type: 'userInvitations',
    attributes: { email: 'a@example.com', firstName: 'A', lastName: 'B', roles: ['DEVELOPER'], allAppsVisible: true },
  },
};

afterEach(() => setFeatureSource(() => ({})));

test('every write operation in Apple\'s spec maps to a known feature', () => {
  const known = new Set(FEATURES.map((f) => f.key));
  for (const op of ops().filter((o) => o.method !== 'GET')) assert.ok(known.has(featureFor(op.path)), op.path);
});

test('key paths map to the expected features', () => {
  const cases = {
    '/v1/userInvitations': 'users',
    '/v1/certificates/{id}': 'signing',
    '/v1/buildUploads': 'uploads',
    '/v1/betaBuildLocalizations/{id}': 'testing',
    '/v1/betaAppReviewSubmissions': 'testing',
    '/v1/builds/{id}': 'testing',
    '/v1/apps/{id}/relationships/betaTesters': 'testing',
    '/v1/betaGroups/{id}/relationships/builds': 'testing',
    '/v1/customerReviewResponses': 'reviews',
    '/v1/appCustomProductPages': 'marketing',
    '/v1/subscriptionOfferCodes': 'pricing',
    '/v1/winBackOffers': 'pricing',
    '/v1/appStoreVersionLocalizations/{id}': 'listing',
    '/v1/appPreviews': 'listing',
    '/v1/appStoreVersions/{id}/relationships/build': 'releases',
    '/v1/reviewSubmissions': 'releases',
    '/v1/gameCenterLeaderboards': 'advanced',
  };
  for (const [path, feature] of Object.entries(cases)) assert.equal(featureFor(path), feature, path);
});

test('a switched-off feature is Tier 3 for every one of its operations', async () => {
  for (const f of FEATURES.filter((x) => !x.stores || x.stores.includes('apple'))) {
    setFeatureSource(() => ({ [f.key]: false }));
    const mine = ops().filter((o) => o.method !== 'GET' && o.method !== 'DELETE' && featureFor(o.path) === f.key);
    for (const op of mine) {
      const v = await classify(op, tpl(op), lookupState('PREPARE_FOR_SUBMISSION'));
      assert.equal(v.tier, 3, `${op.method} ${op.path} with ${f.key} off`);
      assert.match(v.reason, /switched off/);
    }
  }
});

test('switching off one feature leaves the others alone', async () => {
  setFeatureSource(() => ({ pricing: false }));
  const v = await classify(find('PATCH', '/v1/appStoreVersionLocalizations/{id}'), '/v1/appStoreVersionLocalizations/5', lookupState('PREPARE_FOR_SUBMISSION'));
  assert.equal(v.tier, 1);
});

test('critical features are off by default, and when switched on they are Tier 2 and sensitive', async () => {
  const off = await classify(invite(), '/v1/userInvitations', lookupState('X'));
  assert.equal(off.tier, 3);
  setFeatureSource(() => ({ users: true, signing: true }));
  for (const path of ['/v1/userInvitations', '/v1/certificates', '/v1/bundleIds']) {
    const op = find('POST', path);
    const v = await classify(op, path, lookupState('X'));
    assert.equal(v.tier, 2, path);
    assert.equal(v.sensitive, true, path);
  }
});

test('deletes stay blocked even when a critical feature is on', async () => {
  setFeatureSource(() => ({ users: true }));
  const v = await classify(find('DELETE', '/v1/users/{id}'), '/v1/users/x', lookupState('X'));
  assert.equal(v.tier, 3);
});

test('a sensitive ticket can only be applied with the sensitive apply tool', async () => {
  setFeatureSource(() => ({ users: true }));
  const d = deps();
  const p = await prepareChange({ op: invite(), body: inviteBody, deps: d });
  assert.equal(p.allowed, true);
  assert.equal(p.sensitive, true);
  assert.match(p.nextStep, /asc_apply_sensitive_change/);
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /asc_apply_sensitive_change/);
  await assert.rejects(applyChange({ ticketId: p.ticket, requireTier1: true, deps: d }), /asc_apply_sensitive_change/);
  const out = await applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d });
  assert.equal(out.applied, true);
});

test('the sensitive apply tool refuses ordinary tickets', async () => {
  const d = deps();
  const op = find('POST', '/v1/customerReviewResponses');
  const body = { data: { type: 'customerReviewResponses', attributes: { responseBody: 'Thanks!' }, relationships: { review: { data: { type: 'customerReviews', id: '1' } } } } };
  const p = await prepareChange({ op, body, deps: d });
  assert.equal(p.allowed, true);
  await assert.rejects(applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d }), /only applies critical changes/);
  assert.equal((await applyChange({ ticketId: p.ticket, deps: d })).applied, true);
});

test('switching a feature off after the preview stops the apply', async () => {
  const d = deps();
  const op = find('POST', '/v1/customerReviewResponses');
  const body = { data: { type: 'customerReviewResponses', attributes: { responseBody: 'Thanks!' }, relationships: { review: { data: { type: 'customerReviews', id: '1' } } } } };
  const p = await prepareChange({ op, body, deps: d });
  setFeatureSource(() => ({ reviews: false }));
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /switched off/);
});

test('a plan with a critical step is sensitive as a whole', async () => {
  setFeatureSource(() => ({ users: true }));
  const d = deps();
  const p = await preparePlan({
    title: 'invite',
    steps: [{ label: 'invite', method: 'POST', path: '/v1/userInvitations', body: inviteBody }],
    deps: d,
  });
  assert.equal(p.sensitive, true);
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /asc_apply_sensitive_change/);
});

test('screenshot uploads are refused when the listing feature is off', async () => {
  setFeatureSource(() => ({ listing: false }));
  const p = await prepareScreenshots(deps(), { appId: '1', displayType: 'APP_IPHONE_67', files: ['x.png'] });
  assert.equal(p.allowed, false);
  assert.match(p.reason, /switched off/);
});
