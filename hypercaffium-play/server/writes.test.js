process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowed, assertWriteAllowed } from './guard.js';
import { classify } from './rules.js';
import { getMethod, loadSpec } from './spec.js';
import { applyChange, diffFields, prepareChange, TicketStore } from './writes.js';

const M = (id) => {
  const m = getMethod(id);
  assert.ok(m, `spec has no ${id}`);
  return m;
};
const PKG = 'com.example.app';
const BASE = `/androidpublisher/v3/applications/${PKG}`;

// ---------- safety tiers ----------

test('every DELETE, users, grants, edit-control and purchase-action method is Tier 3', () => {
  const { methods } = loadSpec();
  const blocked = methods.filter(
    (m) =>
      m.method === 'DELETE' ||
      /^(users|grants)\./.test(m.id) ||
      /^edits\.(commit|delete|insert|validate)$/.test(m.id) ||
      (/^(orders|purchases|externaltransactions)\./.test(m.id) && m.method !== 'GET'),
  );
  assert.ok(blocked.length > 15);
  for (const m of blocked) assert.equal(classify(m).tier, 3, `${m.id} must be blocked`);
});

test('ordinary changes are Tier 2, never Tier 1 (no auto-run rules exist yet)', () => {
  for (const id of ['edits.listings.update', 'edits.tracks.update', 'reviews.reply', 'edits.details.update']) {
    assert.equal(classify(M(id)).tier, 2, id);
  }
  for (const m of loadSpec().methods.filter((x) => x.method !== 'GET')) {
    assert.notEqual(classify(m).tier, 1, `${m.id} must not be auto-run`);
  }
});

// ---------- the write guard ----------

test('write guard allows only edits, commits, app-scoped changes; never users, grants or other deletes', () => {
  assertWriteAllowed('POST', `${BASE}/edits`);
  assertWriteAllowed('POST', `${BASE}/edits/123:commit`);
  assertWriteAllowed('PUT', `${BASE}/edits/123/listings/en-US`);
  assertWriteAllowed('PUT', `${BASE}/edits/123/tracks/production`);
  assertWriteAllowed('POST', `${BASE}/reviews/abc:reply`);
  assertWriteAllowed('DELETE', `${BASE}/edits/123`);
  const bad = [
    ['DELETE', `${BASE}/edits/123/listings/en-US`],
    ['DELETE', `${BASE}/subscriptions/abc`],
    ['POST', '/androidpublisher/v3/developers/1/users'],
    ['PATCH', `${BASE}/grants/x`],
    ['POST', `/androidpublisher/v3/developers/1/users/a@b.c/grants`],
    ['PUT', '/somewhere/else'],
    ['POST', `${BASE}/../../x`],
    ['POST', `${BASE}/edits/%2e%2e/x`],
  ];
  for (const [m, p] of bad) assert.throws(() => assertWriteAllowed(m, p), /Blocked/, `${m} ${p}`);
});

test('the READ guard still blocks every kind of change', () => {
  for (const [m, p] of [
    ['PUT', `${BASE}/edits/1/listings/en-US`],
    ['POST', `${BASE}/edits/1:commit`],
    ['POST', `${BASE}/reviews/a:reply`],
  ]) {
    assert.throws(() => assertAllowed(m, p), /Blocked/, `${m} ${p}`);
  }
});

// ---------- prepare ----------

function deps(overrides = {}) {
  const calls = [];
  const d = {
    calls,
    store: new TicketStore(),
    defaultPackage: () => PKG,
    writesEnabled: () => true,
    get: async () => ({ language: 'en-US', title: 'Old title', shortDescription: 'old short' }),
    withReadContext: async (_pkg, needsEdit, fn) => fn(needsEdit ? 'tempEdit' : null),
    send: async (method, path, query, body) => {
      calls.push([method, path, body]);
      if (method === 'POST' && path.endsWith('/edits')) return { id: 'EDIT1' };
      return { ok: true };
    },
    ...overrides,
  };
  return d;
}

const listingChange = { methodId: 'edits.listings.update', params: { language: 'en-US' }, body: { language: 'en-US', title: 'New title' } };

test('prepare previews before/after, bundles into one edit, and sends nothing', async () => {
  const d = deps();
  const p = await prepareChange({
    changes: [listingChange, { methodId: 'edits.tracks.update', params: { track: 'internal' }, body: { track: 'internal', releases: [] } }],
    deps: d,
  });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.match(p.ticket, /^[0-9a-f]{18}$/);
  assert.equal(p.changes.length, 2);
  assert.equal(p.changes[0].fieldChanges.find((f) => f.field === 'title').from, 'Old title');
  assert.match(p.changes[0].path, /edits\/NEW_EDIT\/listings\/en-US$/);
  assert.match(p.committedTogether, /ONE Play edit/);
  assert.deepEqual(d.calls, [], 'prepare must never send a change');
});

test('prepare rejects reads, file uploads, mixed edit/direct changes and other apps', async () => {
  const d = deps();
  await assert.rejects(() => prepareChange({ changes: [{ methodId: 'reviews.list' }], deps: d }), /only reads data/);
  await assert.rejects(() => prepareChange({ changes: [{ methodId: 'edits.bundles.upload' }], deps: d }), /uploads a file/);
  await assert.rejects(
    () => prepareChange({ changes: [listingChange, { methodId: 'reviews.reply', params: { reviewId: 'r1' }, body: { replyText: 'hi' } }], deps: d }),
    /Do not mix/,
  );
  await assert.rejects(
    () => prepareChange({ changes: [listingChange, { ...listingChange, params: { language: 'de-DE', packageName: 'com.other.app' } }], deps: d }),
    /same app/,
  );
  await assert.rejects(() => prepareChange({ changes: [], deps: d }), /at least one/);
});

test('prepare gives blocked changes no ticket', async () => {
  const d = deps();
  const del = loadSpec().methods.find((m) => m.method === 'DELETE' && /edits\./.test(m.id));
  const p = await prepareChange({ changes: [{ methodId: del.id, params: {} }], deps: d });
  assert.equal(p.allowed, false);
  assert.equal(p.tier, 3);
  assert.equal(p.ticket, undefined);
  const users = await prepareChange({ changes: [{ methodId: 'users.create', params: { parent: 'developers/1' }, body: { email: 'a@b.c' } }], deps: d });
  assert.equal(users.allowed, false);
});

test('diffFields flags unchanged fields', () => {
  const d = diffFields({ a: 1, b: 'x' }, { a: 1, b: 'y', c: 2 });
  assert.deepEqual(d.map((x) => [x.field, x.unchanged]), [['a', true], ['b', false], ['c', false]]);
});

// ---------- apply ----------

test('apply opens an edit, applies every change, commits once, in order', async () => {
  const d = deps();
  const p = await prepareChange({
    changes: [listingChange, { methodId: 'edits.tracks.update', params: { track: 'internal' }, body: { track: 'internal', releases: [] } }],
    deps: d,
  });
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, true);
  assert.deepEqual(
    d.calls.map(([m, path]) => `${m} ${path.replace(PKG, 'PKG')}`),
    [
      'POST /androidpublisher/v3/applications/PKG/edits',
      'PUT /androidpublisher/v3/applications/PKG/edits/EDIT1/listings/en-US',
      'PUT /androidpublisher/v3/applications/PKG/edits/EDIT1/tracks/internal',
      'POST /androidpublisher/v3/applications/PKG/edits/EDIT1:commit',
    ],
  );
  assert.deepEqual(d.calls[1][2], listingChange.body, 'the exact prepared body is sent');
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d }), /already applied/);
});

test('if any change fails, nothing is committed and the edit is discarded', async () => {
  const calls = [];
  const d = deps({
    send: async (method, path, _q, body) => {
      calls.push(`${method} ${path.split('/applications/')[1]}`);
      if (method === 'POST' && path.endsWith('/edits')) return { id: 'EDIT9' };
      if (path.includes('/tracks/')) throw new Error('Google Play API 400: bad release');
      return { ok: true, body };
    },
  });
  const p = await prepareChange({
    changes: [listingChange, { methodId: 'edits.tracks.update', params: { track: 'internal' }, body: { track: 'internal', releases: [] } }],
    deps: d,
  });
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d }), /Change 2 of 2.*Nothing was committed/);
  assert.ok(!calls.some((c) => c.includes(':commit')), 'must not commit');
  assert.ok(calls.some((c) => c.startsWith('DELETE') && c.includes('EDIT9')), 'must discard the edit');
});

test('direct (non-edit) changes are sent once with no edit involved', async () => {
  const d = deps({ get: async () => ({ reviewId: 'r1' }) });
  const p = await prepareChange({
    changes: [{ methodId: 'reviews.reply', params: { reviewId: 'r1' }, body: { replyText: 'Thank you!' } }],
    deps: d,
  });
  assert.equal(p.changes[0].path, `${BASE}/reviews/r1:reply`);
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, true);
  assert.deepEqual(d.calls.map(([m, path]) => `${m} ${path}`), [`POST ${BASE}/reviews/r1:reply`]);
});

test('kill switch refuses apply and keeps the ticket; expired and unknown tickets are refused', async () => {
  let on = false;
  let now = 5_000;
  const d = deps({ writesEnabled: () => on, store: new TicketStore({ ttlMs: 600_000, now: () => now }) });
  const p = await prepareChange({ changes: [listingChange], deps: d });
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d }), /switched off/);
  on = true;
  now += 600_001;
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d }), /expired/);
  await assert.rejects(() => applyChange({ ticketId: 'nope', deps: d }), /Unknown ticket/);
  const fresh = await prepareChange({ changes: [listingChange], deps: d });
  await assert.rejects(() => applyChange({ ticketId: fresh.ticket, requireTier1: true, deps: d }), /not low-risk/);
});
