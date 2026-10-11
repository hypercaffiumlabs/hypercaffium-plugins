process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeAssertion } from './auth.js';
import { audit, readAudit } from './audit.js';
import { assertAllowed } from './guard.js';
import { fillPath, getMethod, loadSpec, searchMethods, splitParams } from './spec.js';
import { buildPlayStatus } from './status.js';
import { limitText, toLocalTime } from './util.js';

// ---------- pure logic ----------

test('makeAssertion produces a valid RS256 JWT with the claims Google requires', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = makeAssertion({
    clientEmail: 'svc@proj.iam.gserviceaccount.com',
    privateKeyPem: pem,
    tokenUri: 'https://oauth2.googleapis.com/token',
    now: 1_700_000_000,
  });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 'svc@proj.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
});

test('guard allows reads and temporary edits, blocks everything that could change the app', () => {
  const base = '/androidpublisher/v3/applications/com.example.app';
  // allowed
  assertAllowed('GET', `${base}/reviews`);
  assertAllowed('GET', `${base}/edits/123/tracks`);
  assertAllowed('GET', `${base}/edits/123/listings/en-US`);
  assertAllowed('GET', `${base}/subscriptions`);
  assertAllowed('GET', '/androidpublisher/v3/developers/123/users');
  assertAllowed('POST', `${base}/edits`);
  assertAllowed('DELETE', `${base}/edits/123`);
  // blocked
  assert.throws(() => assertAllowed('POST', `${base}/edits/123:commit`), /Blocked/);
  assert.throws(() => assertAllowed('POST', `${base}/edits/123/tracks`), /Blocked/);
  assert.throws(() => assertAllowed('POST', `${base}/edits/123/bundles`), /Blocked/);
  assert.throws(() => assertAllowed('POST', `${base}/reviews/abc:reply`), /Blocked/);
  assert.throws(() => assertAllowed('POST', '/androidpublisher/v3/developers/123/users'), /Blocked/);
  assert.throws(() => assertAllowed('PUT', `${base}/edits/123/tracks/production`), /Blocked/);
  assert.throws(() => assertAllowed('PATCH', `${base}/edits/123/listings/en-US`), /Blocked/);
  assert.throws(() => assertAllowed('DELETE', `${base}/edits/123/tracks`), /Blocked/);
  assert.throws(() => assertAllowed('DELETE', `${base}/subscriptions/abc`), /Blocked/);
  assert.throws(() => assertAllowed('GET', `${base}/edits/123:commit`), /Blocked/);
  assert.throws(() => assertAllowed('GET', '/somewhere/else'), /Blocked/);
  assert.throws(() => assertAllowed('GET', `${base}/../../etc`), /Blocked|\.\./);
});

test('spec index covers the whole API and search finds the right methods', () => {
  const { methods } = loadSpec();
  assert.ok(methods.length >= 140, 'expected the full 145-method index');
  assert.ok(searchMethods({ query: 'bundles upload' }).some((m) => m.methodId === 'edits.bundles.upload'));
  const gets = searchMethods({ query: 'listings', httpMethod: 'GET' });
  assert.ok(gets.length > 0 && gets.every((m) => m.httpMethod === 'GET'));
  assert.deepEqual(searchMethods({ query: 'zzzz-not-a-thing' }), []);
});

test('splitParams and fillPath behave', () => {
  const m = getMethod('reviews.list');
  assert.equal(m.method, 'GET');
  const { pathValues, query } = splitParams(m, { packageName: 'com.x.y', maxResults: '5' });
  assert.deepEqual(pathValues, { packageName: 'com.x.y' });
  assert.deepEqual(query, { maxResults: '5' });
  assert.equal(fillPath(m.path, pathValues), '/androidpublisher/v3/applications/com.x.y/reviews');
  assert.throws(() => fillPath(m.path, {}), /Missing path parameter "packageName"/);
  // reserved-expansion parameters keep their slashes; ordinary ones encode them; dot-segments never pass
  assert.equal(fillPath('/v3/{+parent}/users', { parent: 'developers/123' }, ['parent']), '/v3/developers/123/users');
  assert.equal(fillPath('/v3/{parent}/users', { parent: 'a/b' }), '/v3/a%2Fb/users');
  assert.throws(() => fillPath('/v3/{+parent}/users', { parent: 'developers/../x' }, ['parent']), /dot-segment/);
  const users = getMethod('users.list');
  assert.ok(users.params.find((p) => p.name === 'parent').reserved, 'users.list parent must be marked reserved');
});

test('buildPlayStatus finds live, rolling-out, halted and draft releases', () => {
  const s = buildPlayStatus({
    packageName: 'com.x.y',
    tracks: [
      {
        track: 'production',
        releases: [
          { name: '1.1.4', status: 'inProgress', userFraction: 0.1, versionCodes: ['6'] },
          { name: '1.1.3', status: 'completed', versionCodes: ['5'] },
        ],
      },
      { track: 'internal', releases: [{ name: '1.1.4', status: 'completed', versionCodes: ['6'] }] },
      { track: 'beta', releases: [] },
    ],
    bundles: [{ versionCode: 5 }, { versionCode: 6 }],
  });
  assert.equal(s.live.name, '1.1.3');
  assert.equal(s.live.rolloutPercent, 100);
  assert.equal(s.rollingOut.name, '1.1.4');
  assert.equal(s.rollingOut.rolloutPercent, 10);
  assert.deepEqual(s.otherTracks.map((t) => t.track), ['internal']);
  assert.equal(s.latestUploadedVersionCode, 6);
});

test('toLocalTime handles Google protobuf-style seconds and limitText truncates loudly', () => {
  assert.match(toLocalTime({ seconds: '1791679385' }), /EDT|EST/);
  const cut = limitText('x'.repeat(100), 10);
  assert.ok(cut.includes('output cut'));
});

test('audit log appends, reads newest first and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-audit-'));
  const prev = process.env.CLAUDE_PLUGINS_AUDIT_DIR;
  process.env.CLAUDE_PLUGINS_AUDIT_DIR = dir;
  try {
    audit('t', { tool: 'one', ok: true });
    audit('t', { tool: 'two', ok: false });
    assert.deepEqual(readAudit('t', 10).map((e) => e.tool), ['two', 'one']);
    process.env.CLAUDE_PLUGINS_AUDIT_DIR = path.join(dir, 'x\0bad');
    assert.doesNotThrow(() => audit('t', { tool: 'three' }));
  } finally {
    if (prev) process.env.CLAUDE_PLUGINS_AUDIT_DIR = prev;
    else delete process.env.CLAUDE_PLUGINS_AUDIT_DIR;
  }
});

// ---------- the real server over stdio ----------

function startServer() {
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-srv-audit-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./index.js', import.meta.url))], {
    env: {
      ...process.env,
      PLAY_SA_KEY_PATH: '',
      PLAY_PACKAGE_NAME: '',
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

test('server: every tool is read-only, full-coverage tools exist, unconfigured use fails cleanly', async () => {
  const s = startServer();
  try {
    await s.init();
    const tools = await s.tools();
    const names = tools.map((t) => t.name);
    for (const n of ['play_search_api', 'play_describe_method', 'play_call', 'play_release_status', 'play_audit_log']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    const APPLY = new Set(['play_apply_change', 'play_apply_safe_change']);
    for (const t of tools) {
      if (APPLY.has(t.name)) assert.equal(t.annotations?.readOnlyHint, false, `${t.name} changes data and must say so`);
      else assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be marked read-only`);
    }
    assert.equal(tools.find((t) => t.name === 'play_apply_change').annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === 'play_apply_safe_change').annotations.destructiveHint, false);
    assert.match((await s.call('play_check_setup')).text, /"configured": false/);
    const found = await s.call('play_search_api', { query: 'reviews reply' });
    assert.match(found.text, /reviews\.reply/);
    const desc = await s.call('play_describe_method', { methodId: 'reviews.reply' });
    assert.match(desc.text, /"canCallNow": false/);
  } finally {
    s.close();
  }
});

test('server: play_call refuses every non-GET method before any network request', async () => {
  const s = startServer();
  try {
    await s.init();
    const { methods } = loadSpec();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const m = methods.find((x) => x.method === method);
      const r = await s.call('play_call', { methodId: m.id });
      assert.equal(r.isError, true);
      assert.match(r.text, /play_prepare_change/, `${m.id} should be refused`);
    }
  } finally {
    s.close();
  }
});

test('server: every call is recorded in the audit log', async () => {
  const s = startServer();
  try {
    await s.init();
    await s.call('play_search_api', { query: 'tracks' });
    await s.call('play_call', { methodId: 'does.not.exist' });
    const log = await s.call('play_audit_log', { limit: 5 });
    assert.match(log.text, /play_search_api/);
    assert.match(log.text, /does\.not\.exist/);
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
    for (const n of ['play_prepare_change', 'play_apply_change', 'play_apply_safe_change']) assert.ok(names.includes(n), n);

    // A public review reply: Tier 2. Preview works with no credentials (the "before" lookup just notes it failed).
    const prep = await s.call('play_prepare_change', {
      changes: [{ methodId: 'reviews.reply', params: { packageName: 'com.example.app', reviewId: 'r1' }, body: { replyText: 'Thank you!' } }],
    });
    assert.equal(prep.isError, false, prep.text);
    const p = JSON.parse(prep.text);
    assert.equal(p.tier, 2);
    assert.equal(p.writesEnabled, false);
    assert.ok(p.ticket);

    const apply = await s.call('play_apply_change', { ticket: p.ticket });
    assert.equal(apply.isError, true);
    assert.match(apply.text, /switched off/);

    const blocked = JSON.parse(
      (await s.call('play_prepare_change', { changes: [{ methodId: 'users.create', params: { parent: 'developers/1' }, body: { email: 'a@b.c' } }] })).text,
    );
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.tier, 3);

    const log = (await s.call('play_audit_log', { limit: 10 })).text;
    assert.match(log, /"kind": "prepare"/);
    assert.match(log, /"kind": "write"/);
  } finally {
    s.close();
  }
});

// ---------- monitoring ----------

import { diffGoogle, googleCheckChanges, snapshotFromGoogle } from './monitor.js';

test('diffGoogle describes release and rollout changes and new reviews in plain English', () => {
  const t = (status, fraction) => [{ track: 'production', releases: [{ name: '1.1.4', status, userFraction: fraction, versionCodes: ['6'] }] }];
  const prev = snapshotFromGoogle({ packageName: 'p', tracks: t('inProgress', 0.1), reviews: [] });
  const cur = snapshotFromGoogle({
    packageName: 'p',
    tracks: [...t('inProgress', 0.5), { track: 'internal', releases: [{ name: '1.1.5', status: 'completed', versionCodes: ['7'] }] }],
    reviews: [{ reviewId: 'r1', comments: [{ userComment: { starRating: 1, text: 'Crashes on launch' } }] }],
  });
  const msgs = diffGoogle(prev, cur).map((c) => c.message);
  assert.ok(msgs.includes('production 1.1.4: inProgress at 10% → inProgress at 50%.'), msgs.join(' | '));
  assert.ok(msgs.includes('New release on internal: 1.1.5 (completed at 100%).'));
  assert.ok(msgs.some((m) => m.includes('1 star(s) "Crashes on launch"')));
  assert.deepEqual(diffGoogle(cur, cur), []);
});

test('check changes: baseline first, then differences; a failing read does not fake changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'play-state-'));
  process.env.CLAUDE_PLUGINS_STATE_DIR = dir;
  try {
    let fraction = 0.1;
    const run = (fail) =>
      googleCheckChanges({
        packageName: 'com.x.y',
        fetchTracks: async () => {
          if (fail) throw new Error('boom');
          return [{ track: 'production', releases: [{ name: '1.1.4', status: 'inProgress', userFraction: fraction, versionCodes: ['6'] }] }];
        },
        fetchReviews: async () => [],
      });
    assert.equal((await run(false)).baseline, true);
    assert.equal((await run(false)).changed, false);
    assert.equal((await run(true)).changed, false, 'an unreadable track list must not be reported as a change');
    fraction = 0.5;
    const later = await run(false);
    assert.equal(later.changed, true);
    assert.match(later.changes[0].message, /10% → inProgress at 50%/);
  } finally {
    delete process.env.CLAUDE_PLUGINS_STATE_DIR;
  }
});
