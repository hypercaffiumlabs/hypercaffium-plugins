process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeJwt } from './auth.js';
import { audit, readAudit } from './audit.js';
import { fillPath, getOperation, loadSpec, searchOperations } from './spec.js';
import { buildAppleStatus } from './status.js';
import { limitText, toLocalTime } from './util.js';

// ---------- pure logic ----------

test('makeJwt produces a valid ES256 token with the claims Apple requires', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = makeJwt({ keyId: 'ABC123DEFG', issuerId: 'issuer-uuid', keyPem: pem, now: 1_700_000_000 });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.iss, 'issuer-uuid');
  assert.equal(payload.aud, 'appstoreconnect-v1');
  assert.ok(payload.exp - payload.iat <= 20 * 60);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('spec index covers the whole API and search finds the right operations', () => {
  const { operations } = loadSpec();
  assert.ok(operations.length > 1200, 'expected the full 1,300+ operation index');
  const shots = searchOperations({ query: 'app screenshots', limit: 10 });
  assert.ok(shots.some((o) => o.path === '/v1/appScreenshots' && o.method === 'POST'));
  const gets = searchOperations({ query: 'phased release', method: 'GET' });
  assert.ok(gets.length > 0 && gets.every((o) => o.method === 'GET'));
  assert.deepEqual(searchOperations({ query: 'zzzz-not-a-thing' }), []);
});

test('getOperation and fillPath behave', () => {
  const op = getOperation('apps_appStoreVersions_getToManyRelated');
  assert.equal(op.method, 'GET');
  assert.equal(fillPath(op.path, { id: '123' }), '/v1/apps/123/appStoreVersions');
  assert.throws(() => fillPath(op.path, {}), /Missing path parameter "id"/);
  assert.equal(fillPath('/v1/x/{id}', { id: 'a/b c' }), '/v1/x/a%2Fb%20c', 'path values must be URL-encoded');
  assert.throws(() => fillPath('/v1/x/{id}', { id: '..' }), /dot-segment/, 'dot-segments must not escape the path');
});

test('buildAppleStatus separates live, in-flight and builds, in local time', () => {
  const s = buildAppleStatus({
    app: { id: '1', name: 'ExampleApp', bundleId: 'com.x.y' },
    versions: [
      { versionString: '1.1.3', appStoreState: 'READY_FOR_SALE', platform: 'IOS', createdDate: '2026-10-01T19:21:24-07:00' },
      { versionString: '1.1.2', appStoreState: 'REPLACED_WITH_NEW_VERSION', platform: 'IOS', createdDate: '2026-09-20T10:00:00Z' },
      { versionString: '1.1.4', appStoreState: 'WAITING_FOR_REVIEW', platform: 'IOS', createdDate: '2026-10-09T12:00:00Z' },
    ],
    builds: [{ version: '57', processingState: 'VALID', uploadedDate: '2026-10-09T11:00:00Z', expired: false, expirationDate: '2027-01-07T11:00:00Z' }],
    phased: { phasedReleaseState: 'COMPLETE', currentDayNumber: 7, startDate: '2026-10-02T00:00:00Z' },
  });
  assert.equal(s.live.version, '1.1.3');
  assert.equal(s.live.phasedRelease.state, 'COMPLETE');
  assert.deepEqual(s.inFlight.map((v) => v.version), ['1.1.4']);
  assert.equal(s.latestBuilds[0].processingState, 'VALID');
  assert.match(s.live.createdLocal, /EDT|EST/);
});

test('toLocalTime converts offsets and limitText truncates loudly', () => {
  assert.match(toLocalTime('2026-10-10T00:30:00Z'), /Oct 9, 2026.*8:30 PM EDT/);
  assert.equal(toLocalTime(undefined), undefined);
  const cut = limitText('x'.repeat(100), 10);
  assert.ok(cut.startsWith('xxxxxxxxxx') && cut.includes('output cut'));
});

test('audit log appends, reads newest first, trims long strings and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-audit-'));
  const prev = process.env.CLAUDE_PLUGINS_AUDIT_DIR;
  process.env.CLAUDE_PLUGINS_AUDIT_DIR = dir;
  try {
    audit('t', { tool: 'one', ok: true });
    audit('t', { tool: 'two', ok: false, error: 'y'.repeat(500) });
    const got = readAudit('t', 10);
    assert.deepEqual(got.map((e) => e.tool), ['two', 'one']);
    assert.ok(got[0].error.length < 250);
    process.env.CLAUDE_PLUGINS_AUDIT_DIR = path.join(dir, 'x\0bad');
    assert.doesNotThrow(() => audit('t', { tool: 'three' }));
  } finally {
    process.env.CLAUDE_PLUGINS_AUDIT_DIR = prev ?? '';
    if (!prev) delete process.env.CLAUDE_PLUGINS_AUDIT_DIR;
  }
});

// ---------- the real server over stdio ----------

function startServer() {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-srv-audit-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    env: {
      ...process.env,
      ASC_KEY_ID: '',
      ASC_ISSUER_ID: '',
      ASC_KEY_PATH: '',
      USERPROFILE: 'C:\\nonexistent',
      HOME: '/nonexistent',
      CLAUDE_PLUGINS_AUDIT_DIR: auditDir,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) replies.set(msg.id, msg);
      }
    }
  });
  const request = async (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let n = 0; n < 200 && !replies.has(id); n++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(replies.has(id), `no reply to ${method}`);
    return replies.get(id).result;
  };
  return {
    auditDir,
    async init() {
      await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    tools: async () => (await request('tools/list')).tools,
    call: async (name, args = {}) => {
      const r = await request('tools/call', { name, arguments: args });
      return { isError: Boolean(r.isError), text: r.content[0].text };
    },
    close: () => child.kill(),
  };
}

test('server: every tool is read-only, full-coverage tools exist, and unconfigured use fails cleanly', async () => {
  const s = startServer();
  try {
    await s.init();
    const tools = await s.tools();
    const names = tools.map((t) => t.name);
    for (const n of ['asc_search_api', 'asc_describe_operation', 'asc_call', 'asc_release_status', 'asc_audit_log']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    const APPLY = new Set(['asc_apply_change', 'asc_apply_safe_change']);
    for (const t of tools) {
      if (APPLY.has(t.name)) assert.equal(t.annotations?.readOnlyHint, false, `${t.name} changes data and must say so`);
      else assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be marked read-only`);
    }
    assert.equal(tools.find((t) => t.name === 'asc_apply_change').annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'asc_apply_safe_change').annotations.destructiveHint, false);

    const setup = await s.call('asc_check_setup');
    assert.match(setup.text, /"configured": false/);

    // Search and describe work with no credentials (they use the bundled spec).
    const found = await s.call('asc_search_api', { query: 'screenshots', method: 'POST' });
    assert.equal(found.isError, false);
    assert.match(found.text, /appScreenshots_createInstance/);
    const desc = await s.call('asc_describe_operation', { operationId: 'apps_appStoreVersions_getToManyRelated' });
    assert.match(desc.text, /"canCallNow": true/);
  } finally {
    s.close();
  }
});

test('server: asc_call refuses every non-GET operation before any network request', async () => {
  const s = startServer();
  try {
    await s.init();
    const { operations } = loadSpec();
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const op = operations.find((o) => o.method === method);
      const r = await s.call('asc_call', { operationId: op.operationId, pathParams: { id: '1' } });
      assert.equal(r.isError, true);
      assert.match(r.text, /asc_prepare_change/, `${op.operationId} should be refused`);
    }
    const bad = await s.call('asc_next_page', { url: 'https://evil.example.com/v1/apps?cursor=1' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not an App Store Connect API page link/);
  } finally {
    s.close();
  }
});

test('server: every call is recorded in the audit log', async () => {
  const s = startServer();
  try {
    await s.init();
    await s.call('asc_search_api', { query: 'builds' });
    await s.call('asc_call', { operationId: 'does_not_exist' });
    const log = await s.call('asc_audit_log', { limit: 5 });
    assert.match(log.text, /asc_search_api/);
    assert.match(log.text, /does_not_exist/);
    assert.match(log.text, /"ok": false/);
  } finally {
    s.close();
  }
});

test('server: write flow works end to end and the kill switch is on by default', async () => {
  const s = startServer();
  try {
    await s.init();
    const names = (await s.tools()).map((t) => t.name);
    for (const n of ['asc_prepare_change', 'asc_apply_change', 'asc_apply_safe_change']) assert.ok(names.includes(n), n);

    // A public review reply: Tier 2, preview works with no credentials because POST needs no "before" lookup.
    const prep = await s.call('asc_prepare_change', {
      operationId: 'customerReviewResponses_createInstance',
      body: { data: { type: 'customerReviewResponses', attributes: { responseBody: 'Thank you!' }, relationships: { review: { data: { type: 'customerReviews', id: '1' } } } } },
    });
    assert.equal(prep.isError, false, prep.text);
    const p = JSON.parse(prep.text);
    assert.equal(p.tier, 2);
    assert.equal(p.writesEnabled, false);
    assert.ok(p.ticket);

    // Applying is refused while the kill switch is off, with a plain-language reason.
    const apply = await s.call('asc_apply_change', { ticket: p.ticket });
    assert.equal(apply.isError, true);
    assert.match(apply.text, /switched off/);

    // Deletes never even get a ticket.
    const del = await s.call('asc_prepare_change', { operationId: 'betaGroups_deleteInstance', pathParams: { id: '1' } });
    const d = JSON.parse(del.text);
    assert.equal(d.allowed, false);
    assert.equal(d.tier, 3);

    // The audit log recorded the prepare and the refused apply.
    const log = (await s.call('asc_audit_log', { limit: 10 })).text;
    assert.match(log, /"kind": "prepare"/);
    assert.match(log, /"kind": "write"/);
  } finally {
    s.close();
  }
});
