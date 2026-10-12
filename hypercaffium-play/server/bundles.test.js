process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareUploadBundle, runBundle } from './bundles.js';
import { assertWriteAllowed } from './guard.js';
import { setFeatureSource } from './rules.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';
const BASE = `/androidpublisher/v3/applications/${PKG}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'play-aab-'));
function aab(dir, name = 'app.aab') {
  const b = Buffer.alloc(5000, 3);
  b.writeUInt32LE(0x04034b50, 0);
  const p = path.join(dir, name);
  fs.writeFileSync(p, b);
  return p;
}
function fake({ versionCode = 7, uploadFails = false } = {}) {
  const calls = [];
  const d = {
    calls,
    store: new TicketStore(),
    defaultPackage: () => PKG,
    writesEnabled: () => true,
    withReadContext: async (_p, needsEdit, fn) => fn(needsEdit ? 'E0' : null),
    get: async (p) => {
      if (p.endsWith('/bundles')) return { bundles: [{ versionCode: 5 }, { versionCode: 6 }] };
      if (p.includes('/tracks/')) return { track: 'internal', releases: [{ status: 'completed', versionCodes: ['6'] }] };
      throw new Error(`fake: no GET ${p}`);
    },
    send: async (method, p, _q, body) => {
      calls.push([method, p.replace(BASE, ''), body]);
      if (method === 'POST' && p.endsWith('/edits')) return { id: 'E1' };
      return {};
    },
    uploadBundle: async ({ editId, bytes }) => {
      calls.push(['UPLOAD_AAB', editId, bytes.length]);
      if (uploadFails) throw new Error('Google Play upload failed (403): APK specifies a version code that has already been used.');
      return { versionCode, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    },
    uploadMapping: async ({ editId, versionCode: vc }) => {
      calls.push(['UPLOAD_MAPPING', editId, vc]);
      return {};
    },
  };
  d.runBundle = (payload) => runBundle(payload, d);
  return d;
}
afterEach(() => setFeatureSource(() => ({})));

test('bundle upload: preview shows the file, the version-code rule and the track; nothing is sent', async () => {
  const dir = tmp();
  const d = fake();
  const p = await prepareUploadBundle(d, { file: aab(dir) });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.match(p.title, /internal track as a completed release/);
  assert.match(p.versionCodeRule, /highest now: 6/);
  assert.match(p.mappingFile, /none/);
  assert.equal(d.calls.length, 0);
});

test('bundle upload: uploads, attaches the mapping, sets the track and commits in ONE edit', async () => {
  const dir = tmp();
  const map = path.join(dir, 'mapping.txt');
  fs.writeFileSync(map, 'com.example.A -> a:\n');
  const d = fake();
  const p = await prepareUploadBundle(d, { file: aab(dir), mappingFile: map, releaseNotes: [{ language: 'en-US', text: 'New hive view' }] });
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, true);
  assert.equal(out.versionCode, 7);
  assert.deepEqual(
    d.calls.map((c) => (c[0].startsWith('UPLOAD') ? c[0] : `${c[0]} ${c[1]}`)),
    ['POST /edits', 'UPLOAD_AAB', 'UPLOAD_MAPPING', 'PUT /edits/E1/tracks/internal', 'POST /edits/E1:commit'],
  );
  const put = d.calls.find((c) => c[0] === 'PUT')[2];
  assert.deepEqual(put.releases[0], { status: 'completed', versionCodes: ['7'], releaseNotes: [{ language: 'en-US', text: 'New hive view' }] });
});

test('bundle upload: production is always a draft, and keeps serving the live release', async () => {
  const dir = tmp();
  const d = fake();
  await assert.rejects(prepareUploadBundle(d, { file: aab(dir), track: 'production', status: 'completed' }), /always a DRAFT/);
  const p = await prepareUploadBundle(d, { file: aab(dir), track: 'production' });
  assert.match(p.tierReason, /DRAFT/);
  await applyChange({ ticketId: p.ticket, deps: d });
  const put = d.calls.find((c) => c[0] === 'PUT')[2];
  assert.equal(put.releases[0].status, 'draft');
  assert.deepEqual(put.releases[1], { status: 'completed', versionCodes: ['6'] }, 'the completed release keeps serving users');
});

test('bundle upload: a rejected upload discards the edit, so nothing reaches Google Play', async () => {
  const dir = tmp();
  const d = fake({ uploadFails: true });
  const p = await prepareUploadBundle(d, { file: aab(dir) });
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, false);
  assert.match(out.error, /already been used/);
  assert.ok(d.calls.some((c) => c[0] === 'DELETE' && c[1] === '/edits/E1'));
  assert.ok(!d.calls.some((c) => String(c[1]).endsWith(':commit')));
});

test('bundle upload: a file changed after the preview is refused before anything is sent', async () => {
  const dir = tmp();
  const f = aab(dir);
  const d = fake();
  const p = await prepareUploadBundle(d, { file: f });
  fs.appendFileSync(f, 'x');
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, false);
  assert.ok(!d.calls.some((c) => c[0] === 'UPLOAD_AAB'));
});

test('bundle upload: refuses non-bundles and needs both uploads and releases switched on', async () => {
  const dir = tmp();
  const notZip = path.join(dir, 'x.aab');
  fs.writeFileSync(notZip, 'hello');
  await assert.rejects(prepareUploadBundle(fake(), { file: notZip }), /not a valid app bundle/);
  setFeatureSource(() => ({ uploads: false }));
  const off = await prepareUploadBundle(fake(), { file: aab(dir) });
  assert.equal(off.allowed, false);
  assert.match(off.reason, /uploads/);
});

test('the guard only lets bundle and mapping uploads through when uploads are on', () => {
  const up = `/upload${BASE}/edits/E1/bundles`;
  const map = `/upload${BASE}/edits/E1/apks/7/deobfuscationFiles/proguard`;
  assert.doesNotThrow(() => assertWriteAllowed('POST', up, { uploads: true }));
  assert.doesNotThrow(() => assertWriteAllowed('POST', map, { uploads: true }));
  assert.throws(() => assertWriteAllowed('POST', up, { uploads: false }), /uploads/);
  assert.throws(() => assertWriteAllowed('POST', `/upload${BASE}/edits/E1/apks`, { uploads: true }), /not an allowed change/);
});
