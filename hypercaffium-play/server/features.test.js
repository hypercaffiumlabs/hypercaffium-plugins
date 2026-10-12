process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { featuresFor } from '../../shared/features.js';
import { assertWriteAllowed } from './guard.js';
import { classify, featureFor, setFeatureSource } from './rules.js';
import { getMethod, loadSpec } from './spec.js';
import { applyChange, prepareChange, TicketStore } from './writes.js';
import { prepareUploadImages } from './images.js';

const PKG = 'com.example.app';
const M = (id) => {
  const m = getMethod(id);
  assert.ok(m, `spec has no ${id}`);
  return m;
};
const writes = () => loadSpec().methods.filter((m) => m.method !== 'GET');
const deps = () => ({
  store: new TicketStore(),
  defaultPackage: () => PKG,
  writesEnabled: () => true,
  get: async () => ({}),
  withReadContext: async (_pkg, needsEdit, fn) => fn(needsEdit ? 'tempEdit' : null),
  send: async (method, path) => (method === 'POST' && path.endsWith('/edits') ? { id: 'EDIT1' } : { ok: true }),
});

afterEach(() => setFeatureSource(() => ({})));

test('every write method in Google\'s spec maps to a known Play feature', () => {
  const known = new Set(featuresFor('play').map((f) => f.key));
  for (const m of writes()) assert.ok(known.has(featureFor(m.id)), m.id);
});

test('key methods map to the expected features', () => {
  const cases = {
    'users.create': 'users',
    'grants.patch': 'users',
    'orders.refund': 'refunds',
    'purchases.subscriptionsv2.revoke': 'refunds',
    'appsigning.rotateAppSigningKey': 'signing',
    'edits.bundles.upload': 'uploads',
    'edits.deobfuscationfiles.upload': 'uploads',
    'edits.listings.patch': 'listing',
    'edits.images.upload': 'listing',
    'applications.dataSafety': 'listing',
    'edits.testers.patch': 'testing',
    'edits.tracks.update': 'releases',
    'reviews.reply': 'reviews',
    'monetization.subscriptions.basePlans.migratePrices': 'pricing',
    'apprecovery.deploy': 'advanced',
  };
  for (const [id, feature] of Object.entries(cases)) assert.equal(featureFor(id), feature, id);
});

test('a switched-off feature is Tier 3 for every one of its methods', () => {
  for (const f of featuresFor('play')) {
    setFeatureSource(() => ({ [f.key]: false }));
    for (const m of writes().filter((x) => featureFor(x.id) === f.key)) {
      const v = classify(m);
      assert.equal(v.tier, 3, `${m.id} with ${f.key} off`);
    }
  }
});

test('critical features are off by default; app signing rotation is no longer reachable by default', () => {
  for (const id of ['users.create', 'orders.refund', 'appsigning.rotateAppSigningKey', 'purchases.subscriptionsv2.cancel']) {
    const v = classify(M(id));
    assert.equal(v.tier, 3, id);
    assert.match(v.reason, /switched off/);
  }
});

test('critical features switched on are Tier 2 and sensitive; only team-member deletes are allowed', () => {
  setFeatureSource(() => ({ users: true, refunds: true, signing: true }));
  for (const id of ['users.create', 'orders.refund', 'appsigning.rotateAppSigningKey']) {
    const v = classify(M(id));
    assert.equal(v.tier, 2, id);
    assert.equal(v.sensitive, true, id);
  }
  assert.equal(classify(M('users.delete')).sensitive, true, 'removing a team member is a critical, sensitive change');
  assert.equal(classify(M('edits.images.delete')).tier, 3, 'other deletes stay blocked');
  assert.equal(classify(M('inappproducts.delete')).tier, 3);
});

test('the guard refuses critical paths unless their feature is on', () => {
  const refund = `/androidpublisher/v3/applications/${PKG}/orders/123:refund`;
  const rotate = `/androidpublisher/v3/applications/${PKG}/appSigning:rotateAppSigningKey`;
  const invite = '/androidpublisher/v3/developers/123/users';
  const off = { refunds: false, signing: false, users: false };
  assert.throws(() => assertWriteAllowed('POST', refund, off), /refunds/);
  assert.throws(() => assertWriteAllowed('POST', rotate, off), /signing/);
  assert.throws(() => assertWriteAllowed('POST', invite, off), /not an allowed change/);
  const on = { refunds: true, signing: true, users: true };
  assert.doesNotThrow(() => assertWriteAllowed('POST', refund, on));
  assert.doesNotThrow(() => assertWriteAllowed('POST', rotate, on));
  assert.doesNotThrow(() => assertWriteAllowed('POST', invite, on));
  assert.doesNotThrow(() => assertWriteAllowed('DELETE', '/androidpublisher/v3/developers/123/users/a%40b.com', on), 'removing a member is allowed when users is on');
  assert.throws(() => assertWriteAllowed('DELETE', '/androidpublisher/v3/developers/123/users/a%40b.com', off), /not an allowed change/);
  assert.throws(() => assertWriteAllowed('DELETE', '/androidpublisher/v3/developers/123', on), /not an allowed change/);
});

test('a sensitive ticket can only be applied with the sensitive apply tool, and vice versa', async () => {
  setFeatureSource(() => ({ refunds: true }));
  const d = deps();
  const p = await prepareChange({ changes: [{ methodId: 'orders.refund', params: { orderId: 'GPA.1' } }], deps: d });
  assert.equal(p.allowed, true);
  assert.equal(p.sensitive, true);
  assert.match(p.nextStep, /play_apply_sensitive_change/);
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /play_apply_sensitive_change/);
  assert.equal((await applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d })).applied, true);

  const r = await prepareChange({ changes: [{ methodId: 'reviews.reply', params: { reviewId: 'r1' }, body: { replyText: 'Thanks' } }], deps: d });
  await assert.rejects(applyChange({ ticketId: r.ticket, sensitiveTool: true, deps: d }), /only applies critical changes/);
});

test('switching a feature off after the preview stops the apply', async () => {
  const d = deps();
  const r = await prepareChange({ changes: [{ methodId: 'reviews.reply', params: { reviewId: 'r1' }, body: { replyText: 'Thanks' } }], deps: d });
  setFeatureSource(() => ({ reviews: false }));
  await assert.rejects(applyChange({ ticketId: r.ticket, deps: d }), /switched off/);
});

test('image uploads are refused when the listing feature is off', async () => {
  setFeatureSource(() => ({ listing: false }));
  const p = await prepareUploadImages(deps(), { imageType: 'phoneScreenshots', files: ['x.png'] });
  assert.equal(p.allowed, false);
  assert.match(p.reason, /switched off/);
});
