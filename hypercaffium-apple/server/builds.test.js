process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { prepareUploadBuild, runBuildUpload } from './builds.js';
import { readIpaInfo } from './ipa.js';
import { classify, setFeatureSource } from './rules.js';
import { loadSpec } from './spec.js';
import { applyChange, TicketStore } from './writes.js';

// ---- tiny zip + plist builders (test only) ----
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function zip(entries, { deflate = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const xmlPlist = (v, b, id) =>
  Buffer.from(`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleShortVersionString</key><string>${v}</string><key>CFBundleVersion</key><string>${b}</string></dict></plist>`);
function binaryPlist(obj) {
  const keys = Object.keys(obj);
  const strings = [...keys, ...keys.map((k) => obj[k])];
  const objects = [];
  const dict = Buffer.from([0xd0 | keys.length, ...keys.map((_, i) => i + 1), ...keys.map((_, i) => keys.length + i + 1)]);
  objects.push(dict);
  // Strings of 15+ characters store their length as a following int object (0x10 = 1-byte int).
  for (const s of strings) {
    const head = s.length < 15 ? Buffer.from([0x50 | s.length]) : Buffer.from([0x5f, 0x10, s.length]);
    objects.push(Buffer.concat([head, Buffer.from(s, 'latin1')]));
  }
  const header = Buffer.from('bplist00');
  const offsets = [];
  let pos = header.length;
  for (const o of objects) {
    offsets.push(pos);
    pos += o.length;
  }
  const table = Buffer.from(offsets.map((o) => o));
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(1, 6);
  trailer.writeUInt8(1, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(pos), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asc-ipa-'));
function ipa(dir, { v = '1.1.5', b = '58', id = 'com.example.app', binary = false, deflate = true } = {}) {
  const plist = binary ? binaryPlist({ CFBundleShortVersionString: v, CFBundleVersion: b, CFBundleIdentifier: id }) : xmlPlist(v, b, id);
  const p = path.join(dir, 'App.ipa');
  fs.writeFileSync(p, zip([['Payload/App.app/Info.plist', plist], ['Payload/App.app/App', Buffer.alloc(3000, 9)]], { deflate }));
  return p;
}

function fake({ existingBuild = false, uploadState = 'COMPLETE' } = {}) {
  const calls = [];
  const d = {
    calls,
    store: new TicketStore(),
    writesEnabled: () => true,
    get: async (p) => {
      if (p.startsWith('/v1/apps/A1')) return { data: { id: 'A1', type: 'apps', attributes: { bundleId: 'com.example.app' } } };
      if (p.startsWith('/v1/builds')) return { data: existingBuild ? [{ id: 'B', type: 'builds', attributes: {} }] : [] };
      if (p.startsWith('/v1/buildUploads/U1')) return { data: { id: 'U1', type: 'buildUploads', attributes: { state: { state: uploadState } } } };
      throw new Error(`fake: no GET ${p}`);
    },
    send: async (method, p, _q, body) => {
      calls.push({ method, path: p, body });
      if (p === '/v1/buildUploads') return { data: { id: 'U1', type: 'buildUploads' } };
      if (p === '/v1/buildUploadFiles') {
        return { data: { id: 'F1', type: 'buildUploadFiles', attributes: { uploadOperations: [{ method: 'PUT', url: 'https://upload.example/x', offset: 0, length: 100, requestHeaders: [] }] } } };
      }
      return { data: { id: 'F1' } };
    },
  };
  return d;
}
afterEach(() => setFeatureSource(() => ({})));

test('reads version and build from an .ipa with an XML or a binary Info.plist, stored or compressed', () => {
  const dir = tmp();
  for (const opts of [{}, { binary: true }, { deflate: false }, { binary: true, deflate: false }]) {
    const info = readIpaInfo(fs.readFileSync(ipa(dir, opts)));
    assert.deepEqual(info, { versionString: '1.1.5', buildNumber: '58', bundleId: 'com.example.app' }, JSON.stringify(opts));
  }
  assert.throws(() => readIpaInfo(Buffer.from('not a zip at all, sorry')), /not a valid \.ipa/);
  assert.throws(() => readIpaInfo(zip([['Other/file.txt', Buffer.from('x')]])), /Info\.plist/);
});

test('build upload: preview shows what is inside the file and sends nothing', async () => {
  const dir = tmp();
  const d = fake();
  const p = await prepareUploadBuild(d, { appId: 'A1', file: ipa(dir) });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.deepEqual(p.insideTheFile, { versionString: '1.1.5', buildNumber: '58', bundleId: 'com.example.app' });
  assert.equal(d.calls.length, 0);
});

test('build upload: refuses a build number Apple already has, or another app\'s bundle ID', async () => {
  const dir = tmp();
  await assert.rejects(prepareUploadBuild(fake({ existingBuild: true }), { appId: 'A1', file: ipa(dir) }), /already has build 58/);
  await assert.rejects(prepareUploadBuild(fake(), { appId: 'A1', file: ipa(dir, { id: 'com.other.app' }) }), /is for com\.other\.app/);
});

test('build upload: reserve, send the parts, confirm with the checksum, then follow processing', async () => {
  const dir = tmp();
  const d = fake();
  const p = await prepareUploadBuild(d, { appId: 'A1', file: ipa(dir) });
  const payload = d.store.peek(p.ticket).payload;
  const puts = [];
  const out = await runBuildUpload(payload, d, { fetchImpl: async (url, init) => (puts.push([url, init.body.length]), { ok: true }), pollMs: 1 });
  assert.equal(out.applied, true);
  assert.equal(out.uploadState, 'COMPLETE');
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.path}`), ['POST /v1/buildUploads', 'POST /v1/buildUploadFiles', 'PATCH /v1/buildUploadFiles/F1']);
  assert.equal(d.calls[0].body.data.attributes.cfBundleVersion, '58');
  assert.equal(d.calls[2].body.data.attributes.sourceFileChecksums.file.algorithm, 'MD5');
  assert.deepEqual(puts, [['https://upload.example/x', 100]]);
});

test('build upload: Apple rejecting the build is reported as not applied', async () => {
  const dir = tmp();
  const d = fake({ uploadState: 'FAILED' });
  const p = await prepareUploadBuild(d, { appId: 'A1', file: ipa(dir) });
  d.runBuildUpload = (payload) => runBuildUpload(payload, d, { fetchImpl: async () => ({ ok: true }), pollMs: 1 });
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, false);
  assert.equal(out.uploadState, 'FAILED');
});

test('build upload is refused when the uploads feature is off, and buildUploads map to it', async () => {
  setFeatureSource(() => ({ uploads: false }));
  const p = await prepareUploadBuild(fake(), { appId: 'A1', file: ipa(tmp()) });
  assert.equal(p.allowed, false);
  const op = loadSpec().operations.find((o) => o.method === 'POST' && o.path === '/v1/buildUploads');
  assert.equal((await classify(op, '/v1/buildUploads', async () => ({}))).tier, 3);
});
