process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWriteAllowed } from './guard.js';
import { prepareReplaceImages, runImages } from './images.js';
import { classify } from './rules.js';
import { getMethod } from './spec.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';
const BASE = `/androidpublisher/v3/applications/${PKG}`;
const SET = '/listings/en-US/phoneScreenshots';

function fakePlay(images) {
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
      if (p.endsWith(SET)) return { images: typeof images === 'function' ? images() : images };
      throw new Error(`fake: no GET ${p}`);
    },
    send: async (method, p) => {
      calls.push(`${method} ${p.replace(BASE, '')}`);
      if (method === 'POST' && p.endsWith('/edits')) return { id: 'E1' };
      return { ok: true };
    },
    upload: async (u) => {
      uploads.push(u.editId);
      calls.push(`UPLOAD ${u.imageType}`);
      return { image: { id: `new${uploads.length}` } };
    },
  };
  d.runImages = (payload) => runImages(payload, d);
  return d;
}

function png(dir, name, w = 1080, h = 1920) {
  const b = Buffer.alloc(2000, 7);
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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'play-replace-'));
const OLD = Array.from({ length: 8 }, (_, i) => ({ id: `old${i}`, url: `https://example.com/${i}.png` }));

test('replace: the preview lists what is removed (with links) and changes nothing', async () => {
  const dir = tmp();
  const d = fakePlay(OLD);
  const p = await prepareReplaceImages(d, { imageType: 'phoneScreenshots', files: [png(dir, 'a.png'), png(dir, 'b.png')] });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.equal(p.removing.length, 8);
  assert.equal(p.removing[0].link, 'https://example.com/0.png');
  assert.equal(p.adding.length, 2);
  assert.match(p.keepCopies, /no copy/);
  assert.deepEqual(d.calls, [], 'a preview sends nothing');
});

test('replace: clears the set and uploads the new images inside ONE edit, then commits', async () => {
  const dir = tmp();
  const d = fakePlay(OLD);
  const p = await prepareReplaceImages(d, { imageType: 'phoneScreenshots', files: [png(dir, 'a.png'), png(dir, 'b.png')] });
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, true);
  assert.equal(out.removed, 8);
  assert.deepEqual(d.calls, [
    'POST /edits',
    `DELETE /edits/E1${SET}`,
    'UPLOAD phoneScreenshots',
    'UPLOAD phoneScreenshots',
    'POST /edits/E1:commit',
  ]);
});

test('replace: an upload failure discards the edit, so the old images stay live', async () => {
  const dir = tmp();
  const d = fakePlay(OLD);
  d.upload = async () => {
    throw new Error('bad image');
  };
  const p = await prepareReplaceImages(d, { imageType: 'phoneScreenshots', files: [png(dir, 'a.png'), png(dir, 'b.png')] });
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, false);
  assert.ok(d.calls.includes('DELETE /edits/E1'), 'edit discarded');
  assert.ok(!d.calls.some((c) => c.endsWith(':commit')), 'never committed');
});

test('replace: refuses if the live images changed since the preview, before deleting anything', async () => {
  const dir = tmp();
  let current = OLD;
  const d = fakePlay(() => current);
  const p = await prepareReplaceImages(d, { imageType: 'phoneScreenshots', files: [png(dir, 'a.png'), png(dir, 'b.png')] });
  current = OLD.slice(0, 5);
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, false);
  assert.match(out.error, /changed since the preview/);
  assert.ok(!d.calls.some((c) => c.startsWith('DELETE /edits/E1/')), 'the set was never cleared');
});

test('replace: refuses a file that changed on disk, before deleting anything', async () => {
  const dir = tmp();
  const a = png(dir, 'a.png');
  const d = fakePlay(OLD);
  const p = await prepareReplaceImages(d, { imageType: 'phoneScreenshots', files: [a, png(dir, 'b.png')] });
  fs.appendFileSync(a, 'x');
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, false);
  assert.ok(!d.calls.some((c) => c.startsWith('DELETE /edits/E1/')));
});

test('replace: needs a full set (never empty; at least 2 phone screenshots)', async () => {
  const dir = tmp();
  const d = fakePlay(OLD);
  await assert.rejects(prepareReplaceImages(d, { imageType: 'phoneScreenshots', files: [] }), /full set/);
  await assert.rejects(prepareReplaceImages(d, { imageType: 'phoneScreenshots', files: [png(dir, 'a.png')] }), /at least 2/);
});

test('only an image set inside an edit may be deleted; generic deletes stay blocked', () => {
  assert.doesNotThrow(() => assertWriteAllowed('DELETE', `${BASE}/edits/E1${SET}`));
  assert.throws(() => assertWriteAllowed('DELETE', `${BASE}/edits/E1${SET}/someImageId`), /not an allowed change/);
  assert.throws(() => assertWriteAllowed('DELETE', `${BASE}/edits/E1/listings/en-US`), /not an allowed change/);
  assert.equal(classify(getMethod('edits.images.deleteall')).tier, 3, 'no route to it through play_prepare_change');
});
