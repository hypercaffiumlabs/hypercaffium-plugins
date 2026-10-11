process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, readAudit } from './audit.js';
import {
  checkInfoFields,
  checkReviewFields,
  prepareAddBuildToGroup,
  prepareAddTester,
  prepareAppInfo,
  prepareReplyToReview,
  prepareReviewDetails,
  prepareTestflightNotes,
  reviewInbox,
  testflightOverview,
} from './extras.js';
import { findOperation } from './plans.js';
import { classify } from './rules.js';
import { applyChange, TicketStore } from './writes.js';

function fake(routes) {
  const calls = [];
  const find = (method, p) => {
    const key = `${method} ${p.split('?')[0]}`;
    if (!(key in routes)) throw new Error(`fake: no route for ${key}`);
    const h = routes[key];
    return typeof h === 'function' ? h : () => h;
  };
  return {
    calls,
    store: new TicketStore(),
    writesEnabled: () => true,
    get: async (p) => find('GET', p)(p),
    send: async (method, p, _q, body) => {
      calls.push({ method, path: p, body });
      return find(method, p)(body, p);
    },
  };
}
const res = (type, id, attributes = {}, relationships) => ({ id, type, attributes, relationships });
const draftVersion = (state = 'PREPARE_FOR_SUBMISSION') =>
  res('appStoreVersions', 'v2', { versionString: '1.1.4', platform: 'IOS', appStoreState: state, createdDate: '2026-10-09T12:00:00Z' });
const base = (over = {}) => ({
  'GET /v1/apps': { data: [res('apps', '1', { name: 'ExampleApp' })] },
  'GET /v1/apps/1/appStoreVersions': { data: [draftVersion()] },
  ...over,
});

// ---------- reviews ----------

test('review inbox flags replied vs unreplied and hides replied ones by default', async () => {
  const d = fake(
    base({
      'GET /v1/apps/1/customerReviews': {
        data: [
          res('customerReviews', 'r1', { rating: 1, title: 'Crashes', body: 'bad', reviewerNickname: 'A', territory: 'USA', createdDate: '2026-10-09T12:00:00Z' }, { response: { data: null } }),
          res('customerReviews', 'r2', { rating: 5, title: 'Love it', body: 'great', reviewerNickname: 'B', territory: 'USA', createdDate: '2026-10-08T12:00:00Z' }, { response: { data: { type: 'customerReviewResponses', id: 'x1' } } }),
        ],
        included: [res('customerReviewResponses', 'x1', { responseBody: 'Thank you!', state: 'PUBLISHED', lastModifiedDate: '2026-10-08T15:00:00Z' })],
      },
    }),
  );
  const open = await reviewInbox(d, {});
  assert.deepEqual(open.reviews.map((r) => r.id), ['r1']);
  assert.equal(open.unreplied, 1);
  const all = await reviewInbox(d, { unrepliedOnly: false });
  assert.equal(all.reviews.find((r) => r.id === 'r2').reply.text, 'Thank you!');
});

test('replying to a review is a Tier 2 public reply, shows what it replaces, and sends nothing on prepare', async () => {
  const d = fake(
    base({
      'GET /v1/customerReviews/r1': { data: res('customerReviews', 'r1', { rating: 2, title: 'Meh', body: 'slow', reviewerNickname: 'A', territory: 'USA', createdDate: '2026-10-09T12:00:00Z' }) },
      'GET /v1/customerReviews/r1/response': { data: res('customerReviewResponses', 'x1', { responseBody: 'old reply' }) },
      'POST /v1/customerReviewResponses': { data: res('customerReviewResponses', 'x2', { responseBody: 'new reply' }) },
    }),
  );
  const p = await prepareReplyToReview(d, { reviewId: 'r1', text: 'Thanks, fixed in 1.1.4.' });
  assert.equal(p.tier, 2);
  assert.match(p.tierReason, /public reply/);
  assert.equal(p.existingReply, 'old reply');
  assert.match(p.willBePublic, /visible to everyone/);
  assert.equal(d.calls.length, 0);
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, true);
  assert.equal(d.calls[0].body.data.relationships.review.data.id, 'r1');
  await assert.rejects(() => prepareReplyToReview(d, { reviewId: 'r1', text: '' }), /needs text/);
  await assert.rejects(() => prepareReplyToReview(d, { reviewId: 'r1', text: 'x'.repeat(5971) }), /at most 5970/);
});

// ---------- review details ----------

test('review detail fields are validated', () => {
  assert.deepEqual(checkReviewFields({ contactEmail: 'a@b.co', demoAccountRequired: true }), { contactEmail: 'a@b.co', demoAccountRequired: true });
  assert.throws(() => checkReviewFields({ contactEmail: 'nope' }), /email/);
  assert.throws(() => checkReviewFields({ contactPhone: 'call me' }), /phone number/);
  assert.throws(() => checkReviewFields({ demoAccountRequired: 'yes' }), /true or false/);
  assert.throws(() => checkReviewFields({ colour: 'x' }), /Unknown field/);
  assert.throws(() => checkReviewFields({}), /at least one field/);
});

test('review details: Tier 1 on a draft, password masked everywhere but still sent', async () => {
  const detail = res('appStoreReviewDetails', 'R1', { contactEmail: 'old@x.co', demoAccountName: 'demo', demoAccountPassword: 'oldsecret' });
  const d = fake(
    base({
      'GET /v1/appStoreVersions/v2/appStoreReviewDetail': { data: detail },
      'GET /v1/appStoreReviewDetails/R1': { data: detail, included: [draftVersion()] },
      'PATCH /v1/appStoreReviewDetails/R1': { data: detail },
    }),
  );
  const p = await prepareReviewDetails(d, { fields: { demoAccountPassword: 'newsecret123', notes: 'Use the demo login.' } });
  assert.equal(p.tier, 1);
  const text = JSON.stringify(p);
  assert.equal(text.includes('newsecret123'), false, 'new password must not appear in the preview');
  assert.equal(text.includes('oldsecret'), false, 'old password must not appear in the preview');
  assert.match(text, /\(hidden\)/);
  const out = await applyChange({ ticketId: p.ticket, requireTier1: true, deps: d });
  assert.equal(out.applied, true);
  assert.equal(d.calls[0].body.data.attributes.demoAccountPassword, 'newsecret123', 'Apple must receive the real value');
});

test('review details: creates when none exist, and a live version is not Tier 1', async () => {
  const none = fake(
    base({
      'GET /v1/appStoreVersions/v2/appStoreReviewDetail': { data: null },
      'POST /v1/appStoreReviewDetails': { data: res('appStoreReviewDetails', 'R9') },
    }),
  );
  const p = await prepareReviewDetails(none, { fields: { contactFirstName: 'the owner' } });
  assert.equal(p.creating, true);
  assert.equal(p.operation.method, 'POST');
  const op = findOperation('PATCH', '/v1/appStoreReviewDetails/{id}');
  const live = fake({ 'GET /v1/appStoreReviewDetails/R1': { data: res('appStoreReviewDetails', 'R1'), included: [draftVersion('READY_FOR_SALE')] } });
  assert.equal((await classify(op, '/v1/appStoreReviewDetails/R1', (p2) => live.get(p2))).tier, 2);
});

// ---------- app info ----------

test('app info: limits and https URLs are enforced; only an editable app info can change', async () => {
  assert.throws(() => checkInfoFields({ name: 'x'.repeat(31) }), /at most 30/);
  assert.throws(() => checkInfoFields({ privacyPolicyUrl: 'http://example.com' }), /https/);
  assert.deepEqual(checkInfoFields({ subtitle: 'Hive tracker' }), { subtitle: 'Hive tracker' });

  const ok = fake(
    base({
      'GET /v1/apps/1/appInfos': { data: [res('appInfos', 'AI1', { appStoreState: 'PREPARE_FOR_SUBMISSION' })] },
      'GET /v1/appInfos/AI1/appInfoLocalizations': { data: [res('appInfoLocalizations', 'AIL1', { locale: 'en-US', name: 'ExampleApp', subtitle: 'old' })] },
      'GET /v1/appInfoLocalizations/AIL1': { data: res('appInfoLocalizations', 'AIL1', { locale: 'en-US', name: 'ExampleApp', subtitle: 'old' }) },
      'PATCH /v1/appInfoLocalizations/AIL1': { data: res('appInfoLocalizations', 'AIL1') },
    }),
  );
  const p = await prepareAppInfo(ok, { fields: { subtitle: 'Beekeeping, simplified' } });
  assert.equal(p.tier, 2);
  assert.match(p.tierReason, /public on the store/);
  assert.equal(p.publicOnRelease, true);
  assert.deepEqual(p.changes.map((c) => [c.field, c.from, c.to]), [['subtitle', 'old', 'Beekeeping, simplified']]);

  const locked = fake(base({ 'GET /v1/apps/1/appInfos': { data: [res('appInfos', 'AI1', { appStoreState: 'READY_FOR_SALE' })] } }));
  await assert.rejects(() => prepareAppInfo(locked, { fields: { name: 'New' } }), /only be changed while a version is being prepared/);
});

// ---------- TestFlight ----------

const tfRoutes = (over = {}) =>
  base({
    'GET /v1/apps/1/betaGroups': {
      data: [
        res('betaGroups', 'G1', { name: 'Internal', isInternalGroup: true }),
        res('betaGroups', 'G2', { name: 'Beta Friends', isInternalGroup: false, publicLinkEnabled: true, publicLink: 'https://testflight.apple.com/join/x' }),
      ],
    },
    'GET /v1/builds': { data: [res('builds', 'B57', { version: '57', processingState: 'VALID', expired: false })] },
    'GET /v1/builds/B57/betaBuildLocalizations': { data: [] },
    'GET /v1/betaGroups/G1/betaTesters': { data: [], meta: { paging: { total: 2 } } },
    'GET /v1/betaGroups/G2/betaTesters': { data: [], meta: { paging: { total: 14 } } },
    'GET /v1/betaGroups/G1/builds': { data: [res('builds', 'B57', { version: '57', uploadedDate: '2026-10-09T10:00:00Z', expired: false })] },
    'GET /v1/betaGroups/G2/builds': { data: [] },
    'GET /v1/betaTesters': { data: [] },
    ...over,
  });

test('TestFlight overview summarizes groups, testers and builds', async () => {
  const o = await testflightOverview(fake(tfRoutes()), {});
  assert.deepEqual(o.groups.map((g) => [g.name, g.internal, g.testers]), [['Internal', true, 2], ['Beta Friends', false, 14]]);
  assert.equal(o.groups[1].publicLink, 'https://testflight.apple.com/join/x');
  assert.equal(o.groups[0].builds[0].build, '57');
});

test('TestFlight notes are Tier 1 and created when missing', async () => {
  const d = fake(tfRoutes({ 'POST /v1/betaBuildLocalizations': { data: res('betaBuildLocalizations', 'N1') } }));
  const p = await prepareTestflightNotes(d, { buildNumber: '57', whatsNew: 'Please test Top Bar hives.' });
  assert.equal(p.tier, 1);
  assert.equal(p.creatingNewLocale, true);
  await assert.rejects(() => prepareTestflightNotes(d, { buildNumber: '57', whatsNew: '' }), /needs text/);
});

test('adding a tester: new person vs existing person, internal vs external notes, Tier 2 with a reason', async () => {
  const d = fake(tfRoutes());
  const fresh = await prepareAddTester(d, { email: 'new@person.com', group: 'Beta Friends', firstName: 'Pat' });
  assert.equal(fresh.tier, 2);
  assert.match(fresh.tierReason, /invitation/);
  assert.equal(fresh.existingTester, false);
  assert.match(fresh.note, /emails this person an invitation/);
  assert.equal(fresh.requestBody.data.relationships.betaGroups.data[0].id, 'G2');

  const known = fake(tfRoutes({ 'GET /v1/betaTesters': { data: [res('betaTesters', 'T1', { email: 'old@person.com' })] } }));
  const again = await prepareAddTester(known, { email: 'old@person.com', group: 'Internal' });
  assert.equal(again.existingTester, true);
  assert.equal(again.operation.path, '/v1/betaGroups/G1/relationships/betaTesters');
  assert.match(again.note, /already be a user/);

  await assert.rejects(() => prepareAddTester(d, { email: 'bad', group: 'Internal' }), /valid email/);
  await assert.rejects(() => prepareAddTester(d, { email: 'a@b.co', group: 'Nope' }), /No TestFlight group "Nope"/);
});

test('adding a build to a group requires a VALID, unexpired build', async () => {
  const d = fake(tfRoutes());
  const p = await prepareAddBuildToGroup(d, { buildNumber: '57', group: 'Beta Friends' });
  assert.equal(p.tier, 2);
  assert.match(p.note, /beta review/);
  const processing = fake(tfRoutes({ 'GET /v1/builds': { data: [res('builds', 'B58', { version: '58', processingState: 'PROCESSING' })] } }));
  await assert.rejects(() => prepareAddBuildToGroup(processing, { buildNumber: '58', group: 'Internal' }), /not VALID yet/);
});

// ---------- the audit log never records secrets ----------

test('the audit log redacts passwords and tokens, whatever the tool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-redact-'));
  const prev = process.env.CLAUDE_PLUGINS_AUDIT_DIR;
  process.env.CLAUDE_PLUGINS_AUDIT_DIR = dir;
  try {
    audit('t', { tool: 'x', args: { demoAccountPassword: 'hunter2', apiToken: 'abc', nested: { clientSecret: 's3', ok: 'visible' } } });
    const line = JSON.stringify(readAudit('t', 1)[0]);
    for (const secret of ['hunter2', 'abc', 's3']) assert.equal(line.includes(`"${secret}"`), false, `${secret} leaked`);
    assert.match(line, /visible/);
    assert.match(line, /\[hidden\]/);
  } finally {
    if (prev) process.env.CLAUDE_PLUGINS_AUDIT_DIR = prev;
    else delete process.env.CLAUDE_PLUGINS_AUDIT_DIR;
  }
});
