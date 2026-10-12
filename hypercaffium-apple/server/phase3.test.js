process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareExpireBuild, prepareRemoveTester } from './extras.js';
import {
  prepareCreateCustomPage,
  prepareCreateOfferCode,
  prepareCreatePromotionalOffer,
  prepareCreateWinBackOffer,
  prepareGenerateOfferCodes,
  prepareSubmitCustomPage,
} from './marketing.js';
import { setFeatureSource } from './rules.js';
import { inspectVideo, prepareAppPreviews, prepareScreenshots, runScreenshots } from './screenshots.js';
import { applyChange, TicketStore } from './writes.js';

const res = (type, id, attributes = {}, relationships) => ({ id, type, attributes, ...(relationships ? { relationships } : {}) });

function fake(routes) {
  const calls = [];
  const handle = (method, p, body) => {
    const key = `${method} ${p.split('?')[0]}`;
    if (!(key in routes)) throw new Error(`fake: no route for ${key}`);
    const h = routes[key];
    return typeof h === 'function' ? h(body, p) : h;
  };
  const d = {
    calls,
    store: new TicketStore(),
    writesEnabled: () => true,
    get: async (p) => handle('GET', p),
    send: async (method, p, _q, body) => {
      calls.push({ method, path: p, body });
      return handle(method, p, body);
    },
  };
  return d;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asc-p3-'));
function video(dir, name = 'clip.mp4') {
  const b = Buffer.alloc(4000, 1);
  b.writeUInt32BE(24, 0);
  b.write('ftyp', 4, 'latin1');
  const p = path.join(dir, name);
  fs.writeFileSync(p, b);
  return p;
}
function png(dir, name = 'a.png') {
  const b = Buffer.alloc(2000, 7);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(1290, 16);
  b.writeUInt32BE(2796, 20);
  const p = path.join(dir, name);
  fs.writeFileSync(p, b);
  return p;
}
afterEach(() => setFeatureSource(() => ({})));

const TF = {
  'GET /v1/apps/A1/betaGroups': { data: [res('betaGroups', 'G1', { name: 'Beta Friends', isInternalGroup: false })] },
  'GET /v1/betaGroups/G1/betaTesters': { data: [res('betaTesters', 'T1', { email: 'pat@example.com', firstName: 'Pat' })] },
  'DELETE /v1/betaGroups/G1/relationships/betaTesters': { status: 204 },
  'GET /v1/builds': { data: [res('builds', 'B57', { version: '57', processingState: 'VALID', expired: false, uploadedDate: '2026-10-09T12:00:00Z' })] },
  'GET /v1/builds/B57': { data: res('builds', 'B57', { version: '57', expired: false }) },
  'PATCH /v1/builds/B57': { data: res('builds', 'B57', { expired: true }) },
};

test('remove tester: Tier 2, removes exactly that tester from that group', async () => {
  const d = fake(TF);
  const p = await prepareRemoveTester(d, { appId: 'A1', email: 'PAT@example.com', group: 'Beta Friends' });
  assert.equal(p.tier, 2);
  assert.equal(p.feature, 'testing');
  await applyChange({ ticketId: p.ticket, deps: d });
  assert.deepEqual(d.calls[0], { method: 'DELETE', path: '/v1/betaGroups/G1/relationships/betaTesters', body: { data: [{ type: 'betaTesters', id: 'T1' }] } });
  await assert.rejects(prepareRemoveTester(d, { appId: 'A1', email: 'nobody@example.com', group: 'Beta Friends' }), /not in the TestFlight group/);
});

test('expire build: Tier 2 with an explicit cannot-be-undone warning', async () => {
  const d = fake(TF);
  const p = await prepareExpireBuild(d, { appId: 'A1', buildNumber: '57' });
  assert.equal(p.tier, 2);
  assert.match(p.warning, /cannot be undone/);
  assert.match(p.tierReason, /cannot be undone/);
  await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(d.calls[0].body.data.attributes.expired, true);
});

const DRAFT = {
  'GET /v1/apps/A1/appStoreVersions': { data: [res('appStoreVersions', 'V2', { versionString: '1.1.5', platform: 'IOS', appStoreState: 'PREPARE_FOR_SUBMISSION', createdDate: '2026-10-11T00:00:00Z' })] },
  'GET /v1/appStoreVersions/V2/appStoreVersionLocalizations': { data: [res('appStoreVersionLocalizations', 'L1', { locale: 'en-US' })] },
  'GET /v1/appStoreVersionLocalizations/L1/appPreviewSets': { data: [] },
  'POST /v1/appPreviewSets': (body) => res('appPreviewSets', 'PS1', body.data.attributes) && { data: res('appPreviewSets', 'PS1') },
  'POST /v1/appPreviews': { data: res('appPreviews', 'P1', { uploadOperations: [{ method: 'PUT', url: 'https://upload.example/1', offset: 0, length: 4000, requestHeaders: [] }] }) },
  'PATCH /v1/appPreviews/P1': { data: res('appPreviews', 'P1') },
  'GET /v1/appPreviews/P1': { data: res('appPreviews', 'P1', { assetDeliveryState: { state: 'COMPLETE' } }) },
};

test('app previews: only real videos are accepted', () => {
  const dir = tmp();
  assert.equal(inspectVideo(video(dir)).mime, 'video/mp4');
  assert.throws(() => inspectVideo(png(dir)), /\.mov, \.m4v or \.mp4/);
  const fakeMp4 = path.join(dir, 'fake.mp4');
  fs.writeFileSync(fakeMp4, Buffer.alloc(100, 0));
  assert.throws(() => inspectVideo(fakeMp4), /does not look like/);
});

test('app previews: Tier 1 on a draft; creates a preview set and uploads with the video type', async () => {
  const dir = tmp();
  const d = fake(DRAFT);
  const p = await prepareAppPreviews(d, { appId: 'A1', previewType: 'IPHONE_67', files: [video(dir)], previewFrameTimeCode: '00:00:03' });
  assert.equal(p.tier, 1);
  assert.equal(p.asset, 'preview');
  const ticket = d.store.peek(p.ticket).payload;
  const puts = [];
  const out = await runScreenshots(ticket, d, { fetchImpl: async (url, init) => (puts.push([url, init.body.length]), { ok: true }), pollMs: 1 });
  assert.equal(out.applied, true);
  const set = d.calls.find((c) => c.path === '/v1/appPreviewSets');
  assert.equal(set.body.data.attributes.previewType, 'IPHONE_67');
  assert.equal(set.body.data.relationships.appStoreVersionLocalization.data.id, 'L1');
  const item = d.calls.find((c) => c.path === '/v1/appPreviews');
  assert.equal(item.body.data.attributes.mimeType, 'video/mp4');
  assert.equal(item.body.data.attributes.previewFrameTimeCode, '00:00:03');
  assert.deepEqual(puts, [['https://upload.example/1', 4000]]);
  await assert.rejects(prepareAppPreviews(d, { appId: 'A1', previewType: 'IPHONE_67', files: [video(dir)], previewFrameTimeCode: '3s' }), /00:00:05/);
});

const CPP = {
  'GET /v1/apps/A1/appCustomProductPages': { data: [res('appCustomProductPages', 'CP1', { name: 'Beekeepers', visible: false })] },
  'GET /v1/appCustomProductPages/CP1/appCustomProductPageVersions': { data: [res('appCustomProductPageVersions', 'CV1', { state: 'PREPARE_FOR_SUBMISSION' })] },
  'GET /v1/appCustomProductPageVersions/CV1/appCustomProductPageLocalizations': { data: [res('appCustomProductPageLocalizations', 'CL1', { locale: 'en-US' })] },
  'GET /v1/appCustomProductPageLocalizations/CL1/appScreenshotSets': { data: [] },
  'GET /v1/apps/A1/reviewSubmissions': { data: [] },
};

test('custom page screenshots: Tier 2, attached to the page localization, and need the marketing feature', async () => {
  const dir = tmp();
  const d = fake(CPP);
  const p = await prepareScreenshots(d, { appId: 'A1', displayType: 'APP_IPHONE_67', files: [png(dir)], customProductPage: 'Beekeepers' });
  assert.equal(p.tier, 2);
  assert.match(p.target, /Beekeepers/);
  const payload = d.store.peek(p.ticket).payload;
  assert.equal(payload.parentRel.key, 'appCustomProductPageLocalization');
  assert.deepEqual(payload.features, ['listing', 'marketing']);
  setFeatureSource(() => ({ marketing: false }));
  const off = await prepareScreenshots(d, { appId: 'A1', displayType: 'APP_IPHONE_67', files: [png(dir)], customProductPage: 'Beekeepers' });
  assert.equal(off.allowed, false);
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /marketing/);
});

test('create custom page: one request with the version and locale included, copying the live version', async () => {
  const d = fake({ 'GET /v1/apps/A1/appStoreVersions': { data: [res('appStoreVersions', 'LIVE', { versionString: '1.1.4' })] }, 'POST /v1/appCustomProductPages': { data: res('appCustomProductPages', 'CP9') } });
  const p = await prepareCreateCustomPage(d, { appId: 'A1', name: 'Beekeepers', promotionalText: 'Track every hive' });
  assert.equal(p.allowed, true, JSON.stringify(p));
  assert.equal(p.feature, 'marketing');
  assert.match(p.startsFrom, /1\.1\.4/);
  await applyChange({ ticketId: p.ticket, deps: d });
  const body = d.calls[0].body;
  assert.equal(body.data.relationships.appStoreVersionTemplate.data.id, 'LIVE');
  assert.deepEqual(body.included.map((i) => i.type), ['appCustomProductPageVersions', 'appCustomProductPageLocalizations']);
  assert.equal(body.included[1].attributes.promotionalText, 'Track every hive');
});

test('submit custom page: a 3-step plan, refused while another submission is in review', async () => {
  const d = fake(CPP);
  const p = await prepareSubmitCustomPage(d, { appId: 'A1', page: 'Beekeepers' });
  assert.equal(p.allowed, true);
  assert.equal(p.steps.length, 3);
  assert.match(p.steps[1].label, /Beekeepers/);
  const busy = fake({ ...CPP, 'GET /v1/apps/A1/reviewSubmissions': { data: [res('reviewSubmissions', 'S1', { state: 'WAITING_FOR_REVIEW' })] } });
  const b = await prepareSubmitCustomPage(busy, { appId: 'A1', page: 'Beekeepers' });
  assert.equal(b.allowed, false);
  assert.match(b.reason, /WAITING_FOR_REVIEW/);
});

const SUB_PRICES = {
  'GET /v1/subscriptions/SUB1/prices': {
    data: [
      res('subscriptionPrices', 'p1', { startDate: null }, { territory: { data: { type: 'territories', id: 'USA' } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-usa' } } }),
      res('subscriptionPrices', 'p2', { startDate: null }, { territory: { data: { type: 'territories', id: 'CAN' } }, subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: 'pp-can' } } }),
    ],
    included: [],
  },
  'GET /v1/subscriptions/SUB1/pricePoints': { data: [res('subscriptionPricePoints', 'pp-099', { customerPrice: '0.99' })] },
  'GET /v1/subscriptionPricePoints/pp-099/equalizations': {
    data: [res('subscriptionPricePoints', 'pp-099-can', { customerPrice: '1.39' }, { territory: { data: { type: 'territories', id: 'CAN' } } })],
    included: [],
  },
  'POST /v1/subscriptionOfferCodes': { data: res('subscriptionOfferCodes', 'OC1') },
  'POST /v1/subscriptionPromotionalOffers': { data: res('subscriptionPromotionalOffers', 'PO1') },
  'POST /v1/winBackOffers': { data: res('winBackOffers', 'WB1') },
  'POST /v1/subscriptionOfferCodeCustomCodes': { data: res('subscriptionOfferCodeCustomCodes', 'CC1') },
  'POST /v1/subscriptionOfferCodeOneTimeUseCodes': { data: res('subscriptionOfferCodeOneTimeUseCodes', 'OT1') },
};

test('offer code: a free offer names each territory; Tier 2 under pricing', async () => {
  const d = fake(SUB_PRICES);
  const p = await prepareCreateOfferCode(d, { subscriptionId: 'SUB1', name: 'Free month', offerMode: 'FREE_TRIAL', duration: 'ONE_MONTH', numberOfPeriods: 1 });
  assert.equal(p.allowed, true, JSON.stringify(p));
  assert.equal(p.tier, 2);
  assert.equal(p.feature, 'pricing');
  assert.equal(p.territories, 2);
  await applyChange({ ticketId: p.ticket, deps: d });
  const body = d.calls[0].body;
  assert.equal(body.data.relationships.prices.data.length, 2);
  assert.deepEqual(body.included.map((i) => i.relationships.territory.data.id), ['CAN', 'USA']);
  assert.ok(body.included.every((i) => !i.relationships.subscriptionPricePoint), 'free offers carry no price point');
});

test('paid promotional offer: equalized price points per territory', async () => {
  const d = fake(SUB_PRICES);
  const p = await prepareCreatePromotionalOffer(d, { subscriptionId: 'SUB1', name: 'Come back', offerCode: 'comeback', offerMode: 'PAY_AS_YOU_GO', duration: 'ONE_MONTH', numberOfPeriods: 3, amount: 0.99 });
  assert.equal(p.allowed, true, JSON.stringify(p));
  assert.deepEqual(p.priceTable, [
    { territory: 'CAN', price: '1.39' },
    { territory: 'USA', price: '0.99' },
  ]);
  await applyChange({ ticketId: p.ticket, deps: d });
  assert.deepEqual(d.calls[0].body.included.map((i) => i.relationships.subscriptionPricePoint.data.id), ['pp-099-can', 'pp-099']);
  await assert.rejects(prepareCreatePromotionalOffer(d, { subscriptionId: 'SUB1', name: 'x', offerCode: 'x', offerMode: 'PAY_AS_YOU_GO', amount: 0.5 }), /price point/);
});

test('win-back offer: who sees it is spelled out and the body matches Apple\'s schema', async () => {
  const d = fake(SUB_PRICES);
  const p = await prepareCreateWinBackOffer(d, { subscriptionId: 'SUB1', referenceName: 'Q4', offerId: 'wb_q4', startDate: '2026-11-01', lapsedMinMonths: 2, lapsedMaxMonths: 12 });
  assert.equal(p.allowed, true, JSON.stringify(p));
  assert.match(p.whoSeesIt, /lapsed 2 to 12 months ago/);
  await assert.rejects(prepareCreateWinBackOffer(d, { subscriptionId: 'SUB1', referenceName: 'Q4', offerId: 'wb_q4' }), /startDate/);
});

test('offer codes: custom code or one-time batch, validated', async () => {
  const d = fake(SUB_PRICES);
  const c = await prepareGenerateOfferCodes(d, { offerCodeId: 'OC1', numberOfCodes: 500, customCode: 'beekeeper' });
  assert.equal(c.allowed, true, JSON.stringify(c));
  await applyChange({ ticketId: c.ticket, deps: d });
  assert.equal(d.calls[0].body.data.attributes.customCode, 'BEEKEEPER');
  await assert.rejects(prepareGenerateOfferCodes(d, { offerCodeId: 'OC1', numberOfCodes: 10 }), /expirationDate/);
  await assert.rejects(prepareGenerateOfferCodes(d, { offerCodeId: 'OC1', numberOfCodes: 10, customCode: 'no spaces!' }), /letters and digits/);
  const o = await prepareGenerateOfferCodes(d, { offerCodeId: 'OC1', numberOfCodes: 10, expirationDate: '2026-12-31' });
  assert.equal(o.allowed, true);
});

test('offers are refused when pricing is off; custom pages when marketing is off', async () => {
  setFeatureSource(() => ({ pricing: false, marketing: false }));
  const d = fake(SUB_PRICES);
  const p = await prepareCreateOfferCode(d, { subscriptionId: 'SUB1', name: 'Free month' });
  assert.equal(p.allowed, false);
  const c = await prepareCreateCustomPage(fake({ 'GET /v1/apps/A1/appStoreVersions': { data: [] } }), { appId: 'A1', name: 'X' });
  assert.equal(c.allowed, false);
});
