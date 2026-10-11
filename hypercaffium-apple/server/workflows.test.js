process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appleCheckChanges, diffApple } from './monitor.js';
import { findOperation, hasPlaceholder, preparePlan, resolveValue, MAX_STEPS } from './plans.js';
import {
  prepareAttachBuild,
  prepareCancelSubmission,
  prepareCreateVersion,
  prepareListingEdit,
  preparePhasedRelease,
  prepareReleaseNow,
  prepareSubmit,
  releaseOverview,
} from './release.js';
import { imageSize, prepareScreenshots, runScreenshots } from './screenshots.js';
import { validateBody } from './spec.js';
import {
  findPricePoint,
  prepareEditSubscription,
  prepareEditSubscriptionLocalization,
  prepareIntroOffer,
  prepareSetPrice,
  subscriptionOverview,
  subscriptionPrices,
} from './subs.js';
import { applyChange, TicketStore } from './writes.js';

// ---------- a fake App Store Connect ----------

function fake(routes) {
  const calls = [];
  const lookup = (method, p) => {
    const key = `${method} ${p.split('?')[0]}`;
    const h = routes[key];
    if (h === undefined) throw new Error(`fake: no route for ${key}`);
    return typeof h === 'function' ? h : () => h;
  };
  const d = {
    calls,
    store: new TicketStore(),
    writesEnabled: () => true,
    get: async (p) => lookup('GET', p)(p),
    send: async (method, p, query, body) => {
      calls.push({ method, path: p, body });
      return lookup(method, p)(body, p);
    },
  };
  d.runScreenshots = (payload) => runScreenshots(payload, d, { fetchImpl: d.fetchImpl, pollMs: 0, pollTries: 3 });
  return d;
}

const res = (type, id, attributes = {}, relationships) => ({ id, type, attributes, relationships });
const V = (id, versionString, state, created, extra = {}) =>
  res('appStoreVersions', id, { versionString, platform: 'IOS', appStoreState: state, releaseType: 'AFTER_APPROVAL', createdDate: created, ...extra });

function releaseRoutes(over = {}) {
  const draft = V('v2', '1.1.4', 'PREPARE_FOR_SUBMISSION', '2026-10-09T12:00:00Z');
  const live = V('v1', '1.1.3', 'READY_FOR_SALE', '2026-10-01T12:00:00Z');
  const loc = res('appStoreVersionLocalizations', 'L1', {
    locale: 'en-US',
    description: 'A beekeeping app',
    keywords: 'bees,hive',
    supportUrl: 'https://example.com',
    whatsNew: 'Fixes and polish',
  });
  const build = res('builds', 'B57', { version: '57', processingState: 'VALID', expired: false, usesNonExemptEncryption: false, uploadedDate: '2026-10-09T10:00:00Z' });
  const review = res('appStoreReviewDetails', 'R1', { contactFirstName: 'the owner', contactLastName: 'D', contactEmail: 'a@b.c', contactPhone: '+1555', demoAccountRequired: false });
  return {
    'GET /v1/apps': { data: [res('apps', '1', { name: 'ExampleApp', bundleId: 'com.x' })] },
    'GET /v1/apps/1/appStoreVersions': { data: [draft, live] },
    'GET /v1/appStoreVersions/v2': { data: draft, included: [build, loc, review] },
    'GET /v1/appStoreVersions/v2/appStoreVersionLocalizations': { data: [loc] },
    'GET /v1/appStoreVersionLocalizations/L1': {
      data: loc,
      included: [V('v2', '1.1.4', 'PREPARE_FOR_SUBMISSION', '2026-10-09T12:00:00Z')],
    },
    'GET /v1/appStoreVersionLocalizations/L1/appScreenshotSets': {
      data: [{ id: 'S1', type: 'appScreenshotSets', attributes: { screenshotDisplayType: 'APP_IPHONE_67' }, relationships: { appScreenshots: { data: [{ id: 'a' }, { id: 'b' }] } } }],
      included: [{ type: 'appScreenshots', id: 'a' }, { type: 'appScreenshots', id: 'b' }],
    },
    'GET /v1/apps/1/reviewSubmissions': { data: [] },
    'GET /v1/builds': { data: [build] },
    'GET /v1/appStoreVersions/v2/appStoreVersionPhasedRelease': () => {
      throw new Error('404');
    },
    ...over,
  };
}

// ---------- plans ----------

test('placeholders resolve from earlier results, and unresolved ones fail loudly', () => {
  const results = [{ id: 'SUB1', attributes: { state: 'DRAFT' } }];
  assert.equal(resolveValue('{{0.id}}', results), 'SUB1');
  assert.equal(resolveValue('x-{{0.id}}-y', results), 'x-SUB1-y');
  assert.deepEqual(resolveValue({ a: ['{{0.state}}'] }, results), { a: ['DRAFT'] });
  assert.throws(() => resolveValue('{{1.id}}', results), /not run yet/);
  assert.equal(hasPlaceholder({ x: '{{0.id}}' }), true);
  assert.equal(hasPlaceholder({ x: 'plain' }), false);
});

test('plans: blocked steps get no ticket, bad bodies are rejected, size is capped', async () => {
  const d = fake({});
  const del = await preparePlan({ title: 't', steps: [{ label: 'x', method: 'POST', path: '/v1/userInvitations', body: { data: {} } }], deps: d });
  assert.equal(del.allowed, false);
  await assert.rejects(
    () => preparePlan({ title: 't', steps: [{ label: 'x', method: 'POST', path: '/v1/reviewSubmissions', body: { data: { type: 'reviewSubmissions', attributes: { nope: 1 } } } }], deps: d }),
    /invalid body/,
  );
  await assert.rejects(() => preparePlan({ title: 't', steps: Array(MAX_STEPS + 1).fill({ label: 'x', method: 'POST', path: '/v1/reviewSubmissions' }), deps: d }), /at most/);
});

// ---------- schema validation ----------

test('validateBody catches typos, bad enum values, wrong types and missing required parts', () => {
  const op = findOperation('POST', '/v1/subscriptionIntroductoryOffers');
  const good = { data: { type: 'subscriptionIntroductoryOffers', attributes: { offerMode: 'FREE_TRIAL', duration: 'ONE_WEEK', numberOfPeriods: 1 }, relationships: { subscription: { data: { type: 'subscriptions', id: '1' } } } } };
  assert.deepEqual(validateBody(op, good), []);
  const bad = JSON.parse(JSON.stringify(good));
  bad.data.attributes = { offerMode: 'FREE', durations: 'ONE_WEEK', numberOfPeriods: '1' };
  delete bad.data.relationships.subscription;
  const problems = validateBody(op, bad).join(' | ');
  assert.match(problems, /Unknown attribute "durations"/);
  assert.match(problems, /offerMode" must be one of/);
  assert.match(problems, /numberOfPeriods" must be a whole number/);
  assert.match(problems, /Missing required attribute "duration"/);
  assert.match(problems, /Missing required relationship "subscription"/);
});

// ---------- release overview + pre-flight ----------

test('overview: a complete draft is ready to submit', async () => {
  const o = await releaseOverview(fake(releaseRoutes()), {});
  assert.equal(o.version.versionString, '1.1.4');
  assert.equal(o.build.build, '57');
  assert.equal(o.readyToSubmit, true, JSON.stringify(o.problems));
  assert.equal(o.locales[0].screenshotSets[0].count, 2);
  assert.equal(JSON.stringify(o).includes('demoAccountPassword'), false);
});

test('overview: every kind of blocker is reported', async () => {
  const draft = V('v2', '1.1.4', 'PREPARE_FOR_SUBMISSION', '2026-10-09T12:00:00Z');
  const build = res('builds', 'B57', { version: '57', processingState: 'PROCESSING', expired: false, usesNonExemptEncryption: null });
  const loc = res('appStoreVersionLocalizations', 'L1', { locale: 'en-US', description: 'x', keywords: '', supportUrl: '' });
  const o = await releaseOverview(
    fake(
      releaseRoutes({
        'GET /v1/appStoreVersions/v2': { data: draft, included: [build, loc] },
        'GET /v1/apps/1/reviewSubmissions': { data: [res('reviewSubmissions', 'RS1', { state: 'WAITING_FOR_REVIEW' })] },
      }),
    ),
    {},
  );
  assert.equal(o.readyToSubmit, false);
  const text = o.problems.join(' | ');
  for (const re of [/finished processing/, /Export compliance/, /keywords/, /support URL/, /release notes/, /Review details exist/, /already open|No review submission already open/]) {
    assert.match(text, re);
  }
});

// ---------- editing text, build, version ----------

test('release notes: a draft edit is Tier 1 with a before/after diff; limits are enforced', async () => {
  const d = fake(releaseRoutes());
  const p = await prepareListingEdit(d, { locale: 'en-US', fields: { whatsNew: 'Drag and drop hives' } });
  assert.equal(p.tier, 1);
  assert.equal(p.version, '1.1.4');
  assert.deepEqual(p.changes.map((c) => [c.field, c.from, c.to]), [['whatsNew', 'Fixes and polish', 'Drag and drop hives']]);
  await assert.rejects(() => prepareListingEdit(d, { fields: { keywords: 'x'.repeat(101) } }), /at most 100/);
  await assert.rejects(() => prepareListingEdit(d, { fields: { colour: 'x' } }), /Unknown field/);
  await assert.rejects(() => prepareListingEdit(d, { fields: {} }), /at least one field/);
});

test('release notes: a new locale becomes a create; a live version is never edited by default', async () => {
  const d = fake(releaseRoutes());
  const p = await prepareListingEdit(d, { locale: 'es-ES', fields: { whatsNew: 'Novedades' } });
  assert.equal(p.creatingNewLocale, true);
  assert.deepEqual(p.existingLocales, ['en-US']);
  const noDraft = fake(releaseRoutes({ 'GET /v1/apps/1/appStoreVersions': { data: [V('v1', '1.1.3', 'READY_FOR_SALE', '2026-10-01T00:00:00Z')] } }));
  await assert.rejects(() => prepareListingEdit(noDraft, { fields: { whatsNew: 'x' } }), /no editable \(draft\) version/);
});

test('attach build: only a VALID, unexpired build can be attached', async () => {
  const d = fake(releaseRoutes());
  const p = await prepareAttachBuild(d, { buildNumber: '57' });
  assert.equal(p.tier, 1);
  assert.equal(p.operation.path, '/v1/appStoreVersions/v2/relationships/build');
  const processing = fake(releaseRoutes({ 'GET /v1/builds': { data: [res('builds', 'B58', { version: '58', processingState: 'PROCESSING' })] } }));
  await assert.rejects(() => prepareAttachBuild(processing, { buildNumber: '58' }), /not VALID yet/);
  const none = fake(releaseRoutes({ 'GET /v1/builds': { data: [] } }));
  await assert.rejects(() => prepareAttachBuild(none, { buildNumber: '99' }), /No build "99"/);
});

test('create version: Tier 1; refuses duplicates and a second open draft', async () => {
  const live = fake(releaseRoutes({ 'GET /v1/apps/1/appStoreVersions': { data: [V('v1', '1.1.3', 'READY_FOR_SALE', '2026-10-01T00:00:00Z')] } }));
  const p = await prepareCreateVersion(live, { versionString: '1.1.4' });
  assert.equal(p.tier, 1);
  assert.equal(p.requestBody.data.attributes.releaseType, 'AFTER_APPROVAL');
  await assert.rejects(() => prepareCreateVersion(live, { versionString: '1.1.3' }), /already exists/);
  await assert.rejects(() => prepareCreateVersion(fake(releaseRoutes()), { versionString: '1.1.5' }), /already an editable version/);
  await assert.rejects(() => prepareCreateVersion(live, { versionString: 'banana' }), /must look like/);
});

// ---------- submit ----------

test('submit: a ready draft becomes a 3-step Tier 2 plan that runs in order with resolved IDs', async () => {
  const d = fake({
    ...releaseRoutes(),
    'POST /v1/reviewSubmissions': () => ({ data: { id: 'RS9', type: 'reviewSubmissions', attributes: { state: 'READY_FOR_REVIEW' } } }),
    'POST /v1/reviewSubmissionItems': () => ({ data: { id: 'RSI1', type: 'reviewSubmissionItems' } }),
    'PATCH /v1/reviewSubmissions/RS9': () => ({ data: { id: 'RS9', type: 'reviewSubmissions', attributes: { state: 'WAITING_FOR_REVIEW' } } }),
  });
  const p = await prepareSubmit(d, {});
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.equal(p.stepCount, 3);
  assert.match(p.afterApproval, /release AUTOMATICALLY/);
  assert.equal(d.calls.length, 0, 'preparing must not send anything');

  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, true);
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.path}`), ['POST /v1/reviewSubmissions', 'POST /v1/reviewSubmissionItems', 'PATCH /v1/reviewSubmissions/RS9']);
  assert.equal(d.calls[1].body.data.relationships.reviewSubmission.data.id, 'RS9', 'placeholder resolved to the created ID');
  assert.equal(d.calls[2].body.data.attributes.submitted, true);
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d }), /already applied/);
});

test('submit: reuses an existing unsubmitted submission, and refuses when blockers exist', async () => {
  const reuse = fake({
    ...releaseRoutes({ 'GET /v1/apps/1/reviewSubmissions': { data: [res('reviewSubmissions', 'RS5', { state: 'READY_FOR_REVIEW' })] } }),
  });
  // an open READY_FOR_REVIEW submission is a blocker for the overview check, so it must NOT be silently reused
  const p = await prepareSubmit(reuse, {});
  assert.equal(p.allowed, false);
  assert.match(p.problems.join(' '), /submission/i);

  const noBuild = fake(releaseRoutes({ 'GET /v1/appStoreVersions/v2': { data: V('v2', '1.1.4', 'PREPARE_FOR_SUBMISSION', '2026-10-09T12:00:00Z'), included: [] } }));
  const q = await prepareSubmit(noBuild, {});
  assert.equal(q.allowed, false);
  assert.equal(q.ticket, undefined, 'a blocked submit must not get a ticket');
  assert.match(q.problems.join(' '), /A build is attached/);
});

test('submit: if a step fails, the plan stops and says exactly what happened', async () => {
  const d = fake({
    ...releaseRoutes(),
    'POST /v1/reviewSubmissions': () => ({ data: { id: 'RS9', type: 'reviewSubmissions' } }),
    'POST /v1/reviewSubmissionItems': () => {
      throw new Error('Apple API 409: item invalid');
    },
  });
  const p = await prepareSubmit(d, {});
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, false);
  assert.equal(out.partial, true);
  assert.equal(out.completed.length, 1);
  assert.equal(out.failedStep.step, 1);
  assert.equal(out.notExecuted.length, 1);
  assert.match(out.advice, /already took effect/);
});

test('cancel, phased release and manual release each produce a Tier 2 preview with the right request', async () => {
  const waiting = fake(releaseRoutes({ 'GET /v1/apps/1/reviewSubmissions': { data: [res('reviewSubmissions', 'RS2', { state: 'WAITING_FOR_REVIEW' })] } }));
  const c = await prepareCancelSubmission(waiting, {});
  assert.equal(c.tier, 2);
  assert.equal(c.requestBody.data.attributes.canceled, true);
  await assert.rejects(() => prepareCancelSubmission(fake(releaseRoutes()), {}), /no open review submission/);

  const ph = fake(
    releaseRoutes({
      'GET /v1/appStoreVersions/v2/appStoreVersionPhasedRelease': { data: res('appStoreVersionPhasedReleases', 'PR1', { phasedReleaseState: 'ACTIVE', currentDayNumber: 2 }) },
    }),
  );
  const pause = await preparePhasedRelease(ph, { action: 'pause' });
  assert.equal(pause.requestBody.data.attributes.phasedReleaseState, 'PAUSED');
  const enable = await preparePhasedRelease(fake(releaseRoutes()), { action: 'enable' });
  assert.equal(enable.requestBody.data.attributes.phasedReleaseState, 'INACTIVE');
  await assert.rejects(() => preparePhasedRelease(fake(releaseRoutes()), { action: 'pause' }), /no phased release/);

  const pending = fake(releaseRoutes({ 'GET /v1/apps/1/appStoreVersions': { data: [V('v2', '1.1.4', 'PENDING_DEVELOPER_RELEASE', '2026-10-09T12:00:00Z')] } }));
  const rel = await prepareReleaseNow(pending, {});
  assert.equal(rel.tier, 2);
  assert.match(rel.warning, /available to users/);
  await assert.rejects(() => prepareReleaseNow(fake(releaseRoutes()), {}), /Only a version that is PENDING_DEVELOPER_RELEASE/);
});

// ---------- subscriptions ----------

const subRoutes = (over = {}) => ({
  'GET /v1/apps': { data: [res('apps', '1', { name: 'ExampleApp' })] },
  'GET /v1/subscriptions/sub1/prices': {
    data: [
      res('subscriptionPrices', 'p1', { startDate: null }, { subscriptionPricePoint: { data: { id: 'pp-us-499' } }, territory: { data: { id: 'USA' } } }),
      res('subscriptionPrices', 'p2', { startDate: '2099-01-01' }, { subscriptionPricePoint: { data: { id: 'pp-us-599' } }, territory: { data: { id: 'USA' } } }),
      res('subscriptionPrices', 'p3', { startDate: null }, { subscriptionPricePoint: { data: { id: 'pp-deu-499' } }, territory: { data: { id: 'DEU' } } }),
    ],
    included: [
      res('subscriptionPricePoints', 'pp-us-499', { customerPrice: '4.99', proceeds: '3.49' }),
      res('subscriptionPricePoints', 'pp-us-599', { customerPrice: '5.99', proceeds: '4.19' }),
      res('subscriptionPricePoints', 'pp-deu-499', { customerPrice: '4.49', proceeds: '3.0' }),
      res('territories', 'USA', { currency: 'USD' }),
      res('territories', 'DEU', { currency: 'EUR' }),
    ],
  },
  'GET /v1/subscriptions/sub1/pricePoints': {
    data: [res('subscriptionPricePoints', 'pp-us-499', { customerPrice: '4.99' }), res('subscriptionPricePoints', 'pp-us-599', { customerPrice: '5.99' }), res('subscriptionPricePoints', 'pp-us-699', { customerPrice: '6.99' })],
  },
  'GET /v1/subscriptionPricePoints/pp-us-599/equalizations': {
    data: [
      res('subscriptionPricePoints', 'pp-deu-549', { customerPrice: '5.49' }, { territory: { data: { id: 'DEU' } } }),
      res('subscriptionPricePoints', 'pp-gbr-499', { customerPrice: '4.99' }, { territory: { data: { id: 'GBR' } } }),
    ],
    included: [res('territories', 'DEU', { currency: 'EUR' }), res('territories', 'GBR', { currency: 'GBP' })],
  },
  'GET /v1/subscriptions/sub1/subscriptionLocalizations': { data: [res('subscriptionLocalizations', 'sl1', { locale: 'en-US', name: 'Pro', description: 'All features', state: 'APPROVED' })] },
  'GET /v1/subscriptions/sub1': { data: res('subscriptions', 'sub1', { name: 'Pro' }) },
  ...over,
});

test('subscription prices separate what is in effect from what is scheduled', async () => {
  const r = await subscriptionPrices(fake(subRoutes()), { subscriptionId: 'sub1' });
  const usa = r.current.find((x) => x.territory === 'USA');
  assert.equal(usa.customerPrice, '4.99');
  assert.equal(usa.currency, 'USD');
  assert.equal(r.current.find((x) => x.territory === 'DEU').currency, 'EUR');
  assert.deepEqual(r.scheduled.map((x) => [x.territory, x.customerPrice, x.startDate]), [['USA', '5.99', '2099-01-01']]);
});

test('price points: exact match, or the nearest allowed amounts', async () => {
  const d = fake(subRoutes());
  assert.equal((await findPricePoint(d, { subscriptionId: 'sub1', amount: 5.99 })).match.id, 'pp-us-599');
  const near = await findPricePoint(d, { subscriptionId: 'sub1', amount: 5.5 });
  assert.equal(near.match, null);
  assert.equal(near.nearest[0].customerPrice, '5.99');
});

test('set price (one territory): Tier 2 plan, preserves current subscribers by default, shows old and new', async () => {
  const d = fake(subRoutes());
  const p = await prepareSetPrice(d, { subscriptionId: 'sub1', amount: 5.99 });
  assert.equal(p.tier, 2);
  assert.equal(p.stepCount, 1);
  assert.equal(p.summary.existingSubscribers.startsWith('Existing subscribers KEEP'), true);
  assert.deepEqual(p.priceTable[0], { territory: 'USA', currency: 'USD', from: '4.99', to: '5.99', changePercent: 20 });
  assert.equal(p.steps[0].requestBody.data.attributes.preserveCurrentPrice, true);
  assert.equal(d.calls.length, 0);
});

test('set price (all territories): one step per territory with equalized prices and a full table', async () => {
  const p = await prepareSetPrice(fake(subRoutes()), { subscriptionId: 'sub1', amount: 5.99, allTerritories: true, startDate: '2099-02-01', preserveCurrentPrice: false });
  assert.equal(p.stepCount, 3);
  assert.deepEqual(p.priceTable.map((r) => r.territory), ['USA', 'DEU', 'GBR']);
  assert.equal(p.priceTable.find((r) => r.territory === 'DEU').currency, 'EUR');
  assert.match(p.summary.existingSubscribers, /moved to the new price/);
  assert.equal(p.summary.starts, '2099-02-01');
});

test('set price: rejects impossible amounts and past dates', async () => {
  const d = fake(subRoutes());
  await assert.rejects(() => prepareSetPrice(d, { subscriptionId: 'sub1', amount: 5.5 }), /No USA price point is exactly 5.5/);
  await assert.rejects(() => prepareSetPrice(d, { subscriptionId: 'sub1', amount: 5.99, startDate: '2020-01-01' }), /cannot be in the past/);
  await assert.rejects(() => prepareSetPrice(d, { subscriptionId: 'sub1', amount: 5.99, startDate: 'soon' }), /must look like/);
});

test('subscription edits are validated and Tier 2', async () => {
  const d = fake(subRoutes());
  const e = await prepareEditSubscription(d, { subscriptionId: 'sub1', fields: { name: 'Pro Plus' } });
  assert.equal(e.tier, 2);
  await assert.rejects(() => prepareEditSubscription(d, { subscriptionId: 'sub1', fields: { subscriptionPeriod: 'ONE_YEAR' } }), /Cannot change/);
  const l = await prepareEditSubscriptionLocalization(d, { subscriptionId: 'sub1', locale: 'en-US', description: 'Everything unlocked' });
  assert.equal(l.tier, 2);
  assert.equal(l.operation.method, 'PATCH');
  await assert.rejects(() => prepareEditSubscriptionLocalization(d, { subscriptionId: 'sub1', locale: 'en-US', name: 'x'.repeat(31) }), /2 to 30/);
  await assert.rejects(() => prepareEditSubscriptionLocalization(d, { subscriptionId: 'sub1', locale: 'fr-FR', name: 'Pro' }), /needs both name and description/);
});

test('intro offers: free trials work; paid ones need a territory and an allowed price', async () => {
  const d = fake(subRoutes());
  const free = await prepareIntroOffer(d, { subscriptionId: 'sub1', duration: 'ONE_WEEK' });
  assert.equal(free.tier, 2);
  assert.equal(free.requestBody.data.attributes.offerMode, 'FREE_TRIAL');
  await assert.rejects(() => prepareIntroOffer(d, { subscriptionId: 'sub1', offerMode: 'PAY_UP_FRONT', duration: 'ONE_MONTH' }), /need territory and amount/);
  const paid = await prepareIntroOffer(d, { subscriptionId: 'sub1', offerMode: 'PAY_UP_FRONT', duration: 'ONE_MONTH', territory: 'USA', amount: 4.99 });
  assert.equal(paid.requestBody.data.relationships.subscriptionPricePoint.data.id, 'pp-us-499');
});

test('subscription overview assembles groups, subscriptions, offers and the US price', async () => {
  const d = fake(
    subRoutes({
      'GET /v1/apps/1/subscriptionGroups': { data: [res('subscriptionGroups', 'g1', { referenceName: 'ExampleApp Pro' })] },
      'GET /v1/subscriptionGroups/g1/subscriptions': { data: [res('subscriptions', 'sub1', { name: 'Pro Monthly', productId: 'pro_m', state: 'APPROVED', subscriptionPeriod: 'ONE_MONTH', groupLevel: 1 })] },
      'GET /v1/subscriptions/sub1/introductoryOffers': { data: [res('subscriptionIntroductoryOffers', 'io1', {})] },
      'GET /v1/subscriptions/sub1/promotionalOffers': { data: [] },
      'GET /v1/subscriptions/sub1/offerCodes': { data: [] },
    }),
  );
  const o = await subscriptionOverview(d, {});
  const s = o.groups[0].subscriptions[0];
  assert.equal(o.groups[0].group, 'ExampleApp Pro');
  assert.equal(s.productId, 'pro_m');
  assert.equal(s.usPrice.customerPrice, '4.99');
  assert.equal(s.introductoryOffers, 1);
  assert.equal(s.scheduledPriceChanges.length, 1);
});

// ---------- screenshots ----------

function tmpPng(dir, name, size = 2500, w = 1290, h = 2796) {
  const b = Buffer.alloc(size, 7);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  const p = path.join(dir, name);
  fs.writeFileSync(p, b);
  return p;
}

test('image sniffing reads PNG dimensions and rejects non-images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const p = tmpPng(dir, 'a.png', 200, 1290, 2796);
  assert.deepEqual(imageSize(fs.readFileSync(p)), { type: 'png', width: 1290, height: 2796 });
  assert.equal(imageSize(Buffer.from('not an image at all, just text')), null);
});

test('screenshots: validates files and displayType, refuses full sets and non-drafts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const a = tmpPng(dir, 'a.png');
  const d = fake(releaseRoutes());
  await assert.rejects(() => prepareScreenshots(d, { displayType: 'APP_BANANA', files: [a] }), /not valid/);
  await assert.rejects(() => prepareScreenshots(d, { displayType: 'APP_IPHONE_67', files: ['relative.png'] }), /full file path/);
  await assert.rejects(() => prepareScreenshots(d, { displayType: 'APP_IPHONE_67', files: [path.join(dir, 'nope.png')] }), /does not exist/);
  fs.writeFileSync(path.join(dir, 'x.txt'), 'hi');
  await assert.rejects(() => prepareScreenshots(d, { displayType: 'APP_IPHONE_67', files: [path.join(dir, 'x.txt')] }), /only PNG or JPEG/);
  const full = fake(
    releaseRoutes({
      'GET /v1/appStoreVersionLocalizations/L1/appScreenshotSets': {
        data: [{ id: 'S1', type: 'appScreenshotSets', attributes: { screenshotDisplayType: 'APP_IPHONE_67' }, relationships: { appScreenshots: { data: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}` })) } } }],
      },
    }),
  );
  await assert.rejects(() => prepareScreenshots(full, { displayType: 'APP_IPHONE_67', files: [a] }), /exceed 10.*asc_clear_screenshots/s);
  const live = fake(releaseRoutes({ 'GET /v1/apps/1/appStoreVersions': { data: [V('v1', '1.1.3', 'READY_FOR_SALE', '2026-10-01T00:00:00Z')] } }));
  await assert.rejects(() => prepareScreenshots(live, { displayType: 'APP_IPHONE_67', files: [a] }), /no editable \(draft\) version/);
});

test('screenshots: reserve, upload slices in order, commit with checksum, wait for processing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const a = tmpPng(dir, 'a.png', 2500);
  const uploads = [];
  const d = fake({
    ...releaseRoutes(),
    'POST /v1/appScreenshots': () => ({
      data: {
        id: 'SH1',
        type: 'appScreenshots',
        attributes: {
          uploadOperations: [
            { method: 'PUT', url: 'https://upload.example/1', offset: 0, length: 1000, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
            { method: 'PUT', url: 'https://upload.example/2', offset: 1000, length: 1500, requestHeaders: [{ name: 'Content-Type', value: 'image/png' }] },
          ],
        },
      },
    }),
    'PATCH /v1/appScreenshots/SH1': () => ({ data: { id: 'SH1', type: 'appScreenshots' } }),
    'GET /v1/appScreenshots/SH1': () => ({ data: { id: 'SH1', attributes: { assetDeliveryState: { state: 'COMPLETE' } } } }),
  });
  d.fetchImpl = async (url, init) => {
    uploads.push({ url, method: init.method, len: init.body.length, type: init.headers['Content-Type'] });
    return { ok: true, status: 200 };
  };
  const p = await prepareScreenshots(d, { displayType: 'APP_IPHONE_67', files: [a] });
  assert.equal(p.tier, 1);
  assert.equal(p.existingInSet, 2);
  assert.equal(p.files[0].dimensions, '1290x2796');

  const out = await applyChange({ ticketId: p.ticket, requireTier1: true, deps: d });
  assert.equal(out.applied, true, JSON.stringify(out));
  assert.deepEqual(uploads, [
    { url: 'https://upload.example/1', method: 'PUT', len: 1000, type: 'image/png' },
    { url: 'https://upload.example/2', method: 'PUT', len: 1500, type: 'image/png' },
  ]);
  const commit = d.calls.find((c) => c.method === 'PATCH');
  assert.equal(commit.body.data.attributes.uploaded, true);
  assert.match(commit.body.data.attributes.sourceFileChecksum, /^[0-9a-f]{32}$/);
  assert.equal(out.results[0].state, 'COMPLETE');
  assert.ok(!d.calls.some((c) => c.path === '/v1/appScreenshotSets'), 'an existing set must be reused, not recreated');
});

test('screenshots: a file that changed after the preview is refused, and failures are reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  const a = tmpPng(dir, 'a.png', 2500);
  const d = fake(releaseRoutes());
  d.fetchImpl = async () => ({ ok: true, status: 200 });
  const p = await prepareScreenshots(d, { displayType: 'APP_IPHONE_67', files: [a] });
  fs.writeFileSync(a, Buffer.alloc(2500, 9)); // changed on disk
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, false);
  assert.match(out.error, /changed on disk/);

  const b = tmpPng(dir, 'b.png', 2500);
  const d2 = fake({
    ...releaseRoutes(),
    'POST /v1/appScreenshots': () => ({ data: { id: 'SH2', attributes: { uploadOperations: [{ method: 'PUT', url: 'https://u/x', offset: 0, length: 2500, requestHeaders: [] }] } } }),
  });
  d2.fetchImpl = async () => ({ ok: false, status: 403 });
  const p2 = await prepareScreenshots(d2, { displayType: 'APP_IPHONE_67', files: [b] });
  const out2 = await applyChange({ ticketId: p2.ticket, deps: d2 });
  assert.equal(out2.applied, false);
  assert.match(out2.error, /HTTP 403/);
  assert.match(out2.advice, /cannot be deleted/);
});

// ---------- monitoring ----------

test('diffApple describes state changes and new reviews in plain English', () => {
  const prev = { versions: { 'IOS:1.1.4': 'WAITING_FOR_REVIEW' }, builds: { 57: 'PROCESSING' }, submissions: { RS1: 'WAITING_FOR_REVIEW' }, reviews: { r1: '5|Great' } };
  const cur = { versions: { 'IOS:1.1.4': 'IN_REVIEW', 'IOS:1.1.5': 'PREPARE_FOR_SUBMISSION' }, builds: { 57: 'VALID', 58: 'PROCESSING' }, submissions: { RS1: 'IN_REVIEW' }, reviews: { r1: '5|Great', r2: '2|Crashes' } };
  const msgs = diffApple(prev, cur).map((c) => c.message);
  assert.ok(msgs.includes('Version 1.1.4: waiting for review → in review.'));
  assert.ok(msgs.includes('New version 1.1.5 appeared (prepare for submission).'));
  assert.ok(msgs.includes('Build 57: processing → valid.'));
  assert.ok(msgs.includes('New build 58 (processing).'));
  assert.ok(msgs.includes('Review submission: waiting for review → in review.'));
  assert.ok(msgs.some((m) => m.includes('New App Store review: 2 star(s) "Crashes"')));
  assert.deepEqual(diffApple(cur, cur), []);
});

test('check changes: first call saves a baseline, later calls report differences', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  process.env.CLAUDE_PLUGINS_STATE_DIR = dir;
  try {
    let versionState = 'WAITING_FOR_REVIEW';
    const d = fake({
      'GET /v1/apps': { data: [res('apps', '1', {})] },
      'GET /v1/apps/1/appStoreVersions': () => ({ data: [V('v2', '1.1.4', versionState, '2026-10-09T00:00:00Z')] }),
      'GET /v1/builds': { data: [] },
      'GET /v1/apps/1/reviewSubmissions': { data: [] },
      'GET /v1/apps/1/customerReviews': { data: [] },
    });
    const first = await appleCheckChanges(d, {});
    assert.equal(first.baseline, true);
    const same = await appleCheckChanges(d, {});
    assert.equal(same.changed, false);
    versionState = 'IN_REVIEW';
    const later = await appleCheckChanges(d, {});
    assert.equal(later.changed, true);
    assert.match(later.changes[0].message, /waiting for review → in review/);
  } finally {
    delete process.env.CLAUDE_PLUGINS_STATE_DIR;
  }
});

test('regression: relationship endpoints may name a different id than the path', async () => {
  const d = fake(releaseRoutes());
  const p = await prepareAttachBuild(d, { buildNumber: '57' });
  assert.equal(p.requestBody.data.id, 'B57');
  assert.equal(p.operation.path, '/v1/appStoreVersions/v2/relationships/build');
});

test('submit: asking when only a live version exists explains why there is nothing to submit', async () => {
  const onlyLive = fake(
    releaseRoutes({
      'GET /v1/apps/1/appStoreVersions': { data: [V('v1', '1.1.3', 'READY_FOR_SALE', '2026-10-01T00:00:00Z')] },
      'GET /v1/appStoreVersions/v1': { data: V('v1', '1.1.3', 'READY_FOR_SALE', '2026-10-01T00:00:00Z'), included: [] },
    }),
  );
  const p = await prepareSubmit(onlyLive, {});
  assert.equal(p.allowed, false);
  assert.equal(p.ticket, undefined);
  assert.match(p.problems[0], /READY_FOR_SALE, not an editable draft/);
});

test('monitor: a failed read keeps the previous baseline so a later real change is still reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'));
  process.env.CLAUDE_PLUGINS_STATE_DIR = dir;
  try {
    let state = 'WAITING_FOR_REVIEW';
    let broken = false;
    const d = fake({
      'GET /v1/apps': { data: [res('apps', '1', {})] },
      'GET /v1/apps/1/appStoreVersions': () => {
        if (broken) throw new Error('503');
        return { data: [V('v2', '1.1.4', state, '2026-10-09T00:00:00Z')] };
      },
      'GET /v1/builds': { data: [] },
      'GET /v1/apps/1/reviewSubmissions': { data: [] },
      'GET /v1/apps/1/customerReviews': { data: [] },
    });
    await appleCheckChanges(d, {});
    broken = true;
    assert.equal((await appleCheckChanges(d, {})).changed, false);
    broken = false;
    state = 'IN_REVIEW';
    const r = await appleCheckChanges(d, {});
    assert.equal(r.changed, true);
    assert.match(r.changes[0].message, /waiting for review → in review/);
  } finally {
    delete process.env.CLAUDE_PLUGINS_STATE_DIR;
  }
});

// ---------- the narrow screenshot-delete rule ----------

import { classify } from './rules.js';
import { prepareClearScreenshots } from './screenshots.js';
import { prepareChange } from './writes.js';

const shotRoutes = (versionState = 'PREPARE_FOR_SUBMISSION', over = {}) =>
  releaseRoutes({
    'GET /v1/appScreenshots/a': { data: res('appScreenshots', 'a', {}), included: [{ type: 'appScreenshotSets', id: 'S1' }] },
    'GET /v1/appScreenshots/b': { data: res('appScreenshots', 'b', {}), included: [{ type: 'appScreenshotSets', id: 'S1' }] },
    'GET /v1/appScreenshotSets/S1': { data: res('appScreenshotSets', 'S1', {}), included: [{ type: 'appStoreVersionLocalizations', id: 'L1' }] },
    'GET /v1/appStoreVersionLocalizations/L1': {
      data: res('appStoreVersionLocalizations', 'L1', { locale: 'en-US' }),
      included: [V('v2', '1.1.4', versionState, '2026-10-09T12:00:00Z')],
    },
    'DELETE /v1/appScreenshots/a': { status: 204 },
    'DELETE /v1/appScreenshots/b': { status: 204 },
    ...over,
  });

test('delete rule: a screenshot of a DRAFT version is Tier 2; everything else stays blocked', async () => {
  const del = findOperation('DELETE', '/v1/appScreenshots/{id}');
  const lookup = (state) => {
    const d = fake(shotRoutes(state));
    return (p) => d.get(p);
  };
  const draft = await classify(del, '/v1/appScreenshots/a', lookup('PREPARE_FOR_SUBMISSION'));
  assert.equal(draft.tier, 2);
  assert.match(draft.reason, /draft version/);
  for (const state of ['READY_FOR_SALE', 'IN_REVIEW', 'WAITING_FOR_REVIEW', 'PENDING_DEVELOPER_RELEASE']) {
    assert.equal((await classify(del, '/v1/appScreenshots/a', lookup(state))).tier, 3, state);
  }
  const broken = await classify(del, '/v1/appScreenshots/a', async () => {
    throw new Error('network');
  });
  assert.equal(broken.tier, 3, 'if the chain cannot be proven, the delete stays blocked');
  // no other delete became allowed
  for (const [m, p] of [['DELETE', '/v1/appScreenshotSets/{id}'], ['DELETE', '/v1/betaGroups/{id}'], ['DELETE', '/v1/appPreviews/{id}'], ['DELETE', '/v1/subscriptions/{id}']]) {
    const op = findOperation(m, p);
    if (!op) continue;
    assert.equal((await classify(op, p.replace('{id}', 'a'), lookup('PREPARE_FOR_SUBMISSION'))).tier, 3, p);
  }
});

test('prepare for a screenshot delete: draft gets a Tier 2 ticket, a live version gets none', async () => {
  const del = findOperation('DELETE', '/v1/appScreenshots/{id}');
  const ok = await prepareChange({ op: del, pathParams: { id: 'a' }, deps: fake(shotRoutes()) });
  assert.equal(ok.allowed, true);
  assert.equal(ok.tier, 2);
  const live = await prepareChange({ op: del, pathParams: { id: 'a' }, deps: fake(shotRoutes('READY_FOR_SALE')) });
  assert.equal(live.allowed, false);
  assert.equal(live.ticket, undefined);
  assert.match(live.reason, /READY_FOR_SALE/);
});

test('clear screenshots: one Tier 2 plan of deletes (keepFirst respected), applied in order', async () => {
  const d = fake(shotRoutes());
  const p = await prepareClearScreenshots(d, { displayType: 'APP_IPHONE_67' });
  assert.equal(p.tier, 2);
  assert.equal(p.stepCount, 2);
  assert.equal(d.calls.length, 0, 'preview deletes nothing');
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, true);
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.path}`), ['DELETE /v1/appScreenshots/a', 'DELETE /v1/appScreenshots/b']);

  const keep = await prepareClearScreenshots(fake(shotRoutes()), { displayType: 'APP_IPHONE_67', keepFirst: 1 });
  assert.equal(keep.stepCount, 1);
  await assert.rejects(() => prepareClearScreenshots(fake(shotRoutes()), { displayType: 'APP_IPHONE_67', keepFirst: 2 }), /keeps all 2/);
  await assert.rejects(() => prepareClearScreenshots(fake(shotRoutes()), { displayType: 'APP_IPAD_PRO_3GEN_129' }), /no APP_IPAD_PRO_3GEN_129 screenshots/);
  const live = fake(shotRoutes('READY_FOR_SALE', { 'GET /v1/apps/1/appStoreVersions': { data: [V('v1', '1.1.3', 'READY_FOR_SALE', '2026-10-01T00:00:00Z')] } }));
  await assert.rejects(() => prepareClearScreenshots(live, { displayType: 'APP_IPHONE_67', version: '1.1.3' }), /only a draft/);
});

test('delete rule: the apply step re-checks, so a version that went into review refuses the delete', async () => {
  let state = 'PREPARE_FOR_SUBMISSION';
  const routes = shotRoutes();
  routes['GET /v1/appStoreVersionLocalizations/L1'] = () => ({
    data: res('appStoreVersionLocalizations', 'L1', { locale: 'en-US' }),
    included: [V('v2', '1.1.4', state, '2026-10-09T12:00:00Z')],
  });
  const d = fake(routes);
  const p = await prepareClearScreenshots(d, { displayType: 'APP_IPHONE_67' });
  state = 'WAITING_FOR_REVIEW';
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, false);
  assert.equal(out.completed.length, 0);
  assert.match(out.failedStep.error, /Blocked/);
  assert.equal(d.calls.length, 0, 'nothing may be deleted once the version left draft');
});

test('regression: attribute format names (email, uri, int64) are text or numbers, not allowed-value lists', () => {
  const op = findOperation('POST', '/v1/betaTesters');
  const good = { data: { type: 'betaTesters', attributes: { email: 'someone@example.com', firstName: 'A' } } };
  assert.deepEqual(validateBody(op, good), []);
  const bad = { data: { type: 'betaTesters', attributes: { email: 42 } } };
  assert.match(validateBody(op, bad).join(' '), /must be text/);
});
