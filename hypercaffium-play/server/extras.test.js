process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWriteAllowed } from './guard.js';
import { IMAGE_TYPES, imageSize, inspectImage, prepareUploadImages, runImages } from './images.js';
import { checkListingFields, prepareEditListing, prepareReplyToReview } from './listing.js';
import { subscriptionOverview } from './subscriptions.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';
const BASE = `/androidpublisher/v3/applications/${PKG}`;

function fakePlay(routes = {}) {
  const calls = [];
  const uploads = [];
  const d = {
    calls,
    uploads,
    store: new TicketStore(),
    defaultPackage: () => PKG,
    writesEnabled: () => true,
    withReadContext: async (_p, needsEdit, fn) => fn(needsEdit ? 'E0' : null),
    get: async (p) => {
      const key = Object.keys(routes).find((k) => p.endsWith(k));
      if (!key) throw new Error(`fake: no GET ${p}`);
      const v = routes[key];
      return typeof v === 'function' ? v(p) : v;
    },
    send: async (method, p, _q, body) => {
      calls.push({ method, path: p, body });
      if (method === 'POST' && p.endsWith('/edits')) return { id: 'E1' };
      if (p.endsWith(':commit')) return { id: 'E1' };
      return { ok: true };
    },
    upload: async (u) => {
      uploads.push({ ...u, bytes: u.bytes.length });
      return { image: { id: `img${uploads.length}` } };
    },
  };
  d.runImages = (payload) => runImages(payload, d);
  return d;
}

function png(dir, name, w, h, size = 2000) {
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'play-img-'));

// ---------- guard: the single upload endpoint ----------

test('guard allows exactly the listing-image upload endpoint and nothing near it', () => {
  const ok = `/upload${BASE}/edits/E1/listings/en-US/phoneScreenshots`;
  assertWriteAllowed('POST', ok);
  assertWriteAllowed('POST', `/upload${BASE}/edits/E1/listings/en-US/featureGraphic`);
  const bad = [
    ['POST', `/upload${BASE}/edits/E1/listings/en-US/somethingElse`],
    ['POST', `/upload${BASE}/edits/E1/bundles`],
    ['POST', `/upload${BASE}/internalappsharing/apk`],
    ['PUT', ok],
    ['DELETE', ok],
    ['POST', `/upload${BASE}/edits/E1/listings/en-US/../icon`],
    ['POST', '/upload/androidpublisher/v3/developers/1/users'],
  ];
  for (const [m, p] of bad) assert.throws(() => assertWriteAllowed(m, p), /Blocked/, `${m} ${p}`);
});

// ---------- review replies + listing text ----------

test('review reply: public Tier 2, shows the review and any reply it replaces, enforces 350 characters', async () => {
  const d = fakePlay({
    '/reviews/r1': {
      reviewId: 'r1',
      comments: [{ userComment: { starRating: 2, text: 'Slow sync', appVersionName: '1.1.3' } }, { developerComment: { text: 'old reply' } }],
    },
  });
  const p = await prepareReplyToReview(d, { reviewId: 'r1', text: 'Thanks, fixed in 1.1.4.' });
  assert.equal(p.tier, 2);
  assert.match(p.tierReason, /public reply/);
  assert.equal(p.review.stars, 2);
  assert.equal(p.existingReply, 'old reply');
  assert.match(p.willBePublic, /visible to everyone/);
  assert.equal(d.calls.length, 0);
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, true);
  assert.deepEqual(d.calls[0].body, { replyText: 'Thanks, fixed in 1.1.4.' });
  await assert.rejects(() => prepareReplyToReview(d, { reviewId: 'r1', text: 'x'.repeat(351) }), /at most 350/);
  await assert.rejects(() => prepareReplyToReview(d, { reviewId: '', text: 'hi' }), /Pass reviewId/);
});

test('listing edit: limits enforced, before/after shown, applied inside one edit', async () => {
  assert.throws(() => checkListingFields({ title: 'x'.repeat(31) }), /at most 30/);
  assert.throws(() => checkListingFields({ shortDescription: 'x'.repeat(81) }), /at most 80/);
  assert.throws(() => checkListingFields({ video: 'http://x.y' }), /https/);
  assert.throws(() => checkListingFields({ colour: 'blue' }), /Unknown field/);
  const d = fakePlay({ '/listings/en-US': { language: 'en-US', title: 'Old title', shortDescription: 'old' } });
  const p = await prepareEditListing(d, { fields: { title: 'ExampleApp: Tools' } });
  assert.equal(p.tier, 2);
  assert.match(p.tierReason, /public on Google Play/);
  assert.deepEqual(p.changes[0].fieldChanges.map((f) => [f.field, f.from, f.to]), [['title', 'Old title', 'ExampleApp: Tools']]);
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, true);
  assert.deepEqual(d.calls.map((c) => c.method), ['POST', 'PATCH', 'POST']);
});

// ---------- images ----------

test('image rules: exact sizes for icon/featureGraphic, ratio and bounds for screenshots', () => {
  const dir = tmp();
  assert.equal(imageSize(fs.readFileSync(png(dir, 'a.png', 512, 512))).width, 512);
  assert.doesNotThrow(() => inspectImage(png(dir, 'icon.png', 512, 512), IMAGE_TYPES.icon, 'icon'));
  assert.throws(() => inspectImage(png(dir, 'icon2.png', 500, 500), IMAGE_TYPES.icon, 'icon'), /exactly 512x512/);
  assert.doesNotThrow(() => inspectImage(png(dir, 'fg.png', 1024, 500), IMAGE_TYPES.featureGraphic, 'featureGraphic'));
  assert.doesNotThrow(() => inspectImage(png(dir, 's.png', 1080, 1920), IMAGE_TYPES.phoneScreenshots, 'phoneScreenshots'));
  assert.throws(() => inspectImage(png(dir, 'tall.png', 500, 1200), IMAGE_TYPES.phoneScreenshots, 'phoneScreenshots'), /twice the short side/);
  assert.throws(() => inspectImage(png(dir, 'tiny.png', 200, 300), IMAGE_TYPES.phoneScreenshots, 'phoneScreenshots'), /between 320 and 3840/);
  assert.throws(() => inspectImage('relative.png', IMAGE_TYPES.icon, 'icon'), /full file path/);
  fs.writeFileSync(path.join(dir, 'x.gif'), 'GIF89a');
  assert.throws(() => inspectImage(path.join(dir, 'x.gif'), IMAGE_TYPES.icon, 'icon'), /only PNG or JPEG/);
});

test('image upload: previews, refuses a full set, then uploads in order inside one edit and commits', async () => {
  const dir = tmp();
  const a = png(dir, 'a.png', 1080, 1920);
  const b = png(dir, 'b.png', 1080, 1920);
  const d = fakePlay({ '/listings/en-US/phoneScreenshots': { images: [{ id: 'x1' }, { id: 'x2' }] } });
  const p = await prepareUploadImages(d, { imageType: 'phoneScreenshots', files: [a, b] });
  assert.equal(p.tier, 2);
  assert.equal(p.existingCount, 2);
  assert.equal(d.calls.length, 0);
  assert.equal(d.uploads.length, 0, 'preview must not upload anything');

  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, true);
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.path.replace(BASE, '')}`), ['POST /edits', 'POST /edits/E1:commit']);
  assert.deepEqual(d.uploads.map((u) => [u.imageType, u.language, u.mime, u.editId]), [
    ['phoneScreenshots', 'en-US', 'image/png', 'E1'],
    ['phoneScreenshots', 'en-US', 'image/png', 'E1'],
  ]);

  const full = fakePlay({ '/listings/en-US/phoneScreenshots': { images: Array.from({ length: 8 }, (_, i) => ({ id: `i${i}` })) } });
  await assert.rejects(() => prepareUploadImages(full, { imageType: 'phoneScreenshots', files: [a] }), /would exceed 8.*delete/s);
  const icon = fakePlay({ '/listings/en-US/icon': { images: [{ id: 'old' }] } });
  const ip = await prepareUploadImages(icon, { imageType: 'icon', files: [png(dir, 'icon.png', 512, 512)] });
  assert.equal(ip.replacesExisting, true);
});

test('image upload: any failure discards the edit; a changed file is refused; bad input is rejected', async () => {
  const dir = tmp();
  const a = png(dir, 'a.png', 1080, 1920);
  const d = fakePlay({ '/listings/en-US/phoneScreenshots': { images: [] } });
  d.upload = async () => {
    throw new Error('Google Play image upload failed (400): bad image');
  };
  const p = await prepareUploadImages(d, { imageType: 'phoneScreenshots', files: [a] });
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, false);
  assert.equal(out.committed, false);
  assert.match(out.advice, /listing is unchanged/);
  assert.ok(d.calls.some((c) => c.method === 'DELETE'), 'the edit must be discarded');
  assert.ok(!d.calls.some((c) => c.path.endsWith(':commit')), 'must not commit');

  const d2 = fakePlay({ '/listings/en-US/phoneScreenshots': { images: [] } });
  const p2 = await prepareUploadImages(d2, { imageType: 'phoneScreenshots', files: [a] });
  fs.writeFileSync(a, Buffer.alloc(2000, 9)); // changed after preview
  const out2 = await applyChange({ ticketId: p2.ticket, deps: d2 });
  assert.equal(out2.applied, false);
  assert.match(out2.error, /changed on disk/);

  await assert.rejects(() => prepareUploadImages(d2, { imageType: 'banana', files: [a] }), /imageType must be one of/);
  await assert.rejects(() => prepareUploadImages(d2, { imageType: 'icon', files: [] }), /Pass files/);
  await assert.rejects(() => prepareUploadImages(d2, { imageType: 'icon', files: [a, a] }), /at most 1/);
  await assert.rejects(() => prepareUploadImages(d2, { imageType: 'phoneScreenshots', language: 'english', files: [a] }), /language code/);
});

// ---------- subscriptions ----------

test('subscription overview summarizes products and base plans, and explains a 403', async () => {
  const get = async () => ({
    subscriptions: [
      {
        productId: 'master_monthly',
        listings: [{ languageCode: 'en-US', title: 'ExampleApp Master' }],
        basePlans: [{ basePlanId: 'monthly', state: 'ACTIVE', autoRenewingBasePlanType: { billingPeriodDuration: 'P1M' }, regionalConfigs: [{}, {}, {}] }],
      },
    ],
  });
  const o = await subscriptionOverview(get, PKG);
  assert.equal(o.count, 1);
  assert.deepEqual(o.subscriptions[0].basePlans[0], { basePlanId: 'monthly', state: 'ACTIVE', renews: 'auto-renewing', billingPeriod: 'P1M', regionsConfigured: 3 });
  const denied = async () => {
    throw new Error('Google Play API 403 for /x: The caller does not have permission');
  };
  await assert.rejects(() => subscriptionOverview(denied, PKG), /Manage orders and subscriptions/);
});
