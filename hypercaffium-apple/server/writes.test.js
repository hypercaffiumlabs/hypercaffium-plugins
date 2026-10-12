process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, TIER1_IF_DRAFT } from './rules.js';
import { loadSpec } from './spec.js';
import { applyChange, diffAttributes, prepareChange, TicketStore } from './writes.js';

const ops = () => loadSpec().operations;
const find = (method, path) => {
  const op = ops().find((o) => o.method === method && o.path === path);
  assert.ok(op, `spec has no ${method} ${path}`);
  return op;
};
const lookupState = (state) => async () => ({ data: { attributes: { appStoreState: state } } });

// ---------- safety tiers ----------

test('every DELETE in the whole API is Tier 3 (blocked)', async () => {
  const deletes = ops().filter((o) => o.method === 'DELETE');
  assert.ok(deletes.length > 100);
  for (const op of deletes) {
    const v = await classify(op, op.path.replace(/\{[^}]+\}/g, 'x'), lookupState('X'));
    assert.equal(v.tier, 3, `${op.operationId} must be blocked`);
  }
});

test('users and code-signing are Tier 3 for every method while their features are off (the default)', async () => {
  for (const op of ops().filter((o) => /^\/v\d\/(users|userInvitations|certificates|profiles|devices|bundleIds)(\/|$)/.test(o.path))) {
    const v = await classify(op, op.path.replace(/\{[^}]+\}/g, 'x'), lookupState('X'));
    assert.equal(v.tier, 3, `${op.method} ${op.path} must be blocked`);
  }
});

test('outward-facing and live changes are Tier 2', async () => {
  for (const [method, path] of [
    ['POST', '/v1/reviewSubmissions'],
    ['PATCH', '/v1/reviewSubmissions/{id}'],
    ['POST', '/v1/customerReviewResponses'],
    ['POST', '/v1/appPriceSchedules'],
    ['POST', '/v1/buildUploads'],
    ['POST', '/v1/betaTesters'],
  ]) {
    const v = await classify(find(method, path), path.replace('{id}', '1'), lookupState('READY_FOR_SALE'));
    assert.equal(v.tier, 2, `${method} ${path} should need confirmation`);
  }
});

test('TestFlight notes are Tier 1; version edits are Tier 1 only while the version is a draft', async () => {
  const note = find('PATCH', '/v1/betaBuildLocalizations/{id}');
  assert.equal((await classify(note, '/v1/betaBuildLocalizations/9', lookupState('X'))).tier, 1);

  const loc = find('PATCH', '/v1/appStoreVersionLocalizations/{id}');
  assert.equal((await classify(loc, '/v1/appStoreVersionLocalizations/5', lookupState('PREPARE_FOR_SUBMISSION'))).tier, 1);
  assert.equal((await classify(loc, '/v1/appStoreVersionLocalizations/5', lookupState('DEVELOPER_REJECTED'))).tier, 1);
  for (const live of ['READY_FOR_SALE', 'IN_REVIEW', 'WAITING_FOR_REVIEW', 'PENDING_DEVELOPER_RELEASE']) {
    assert.equal((await classify(loc, '/v1/appStoreVersionLocalizations/5', lookupState(live))).tier, 2, live);
  }
  const failing = async () => {
    throw new Error('network down');
  };
  assert.equal((await classify(loc, '/v1/appStoreVersionLocalizations/5', failing)).tier, 2, 'unknown state falls to Tier 2');
});

// ---------- prepare ----------

function deps(overrides = {}) {
  return {
    store: new TicketStore(),
    get: async () => ({ data: { id: '5', type: 'appStoreVersionLocalizations', attributes: { whatsNew: 'old text', locale: 'en-US' } } }),
    send: async () => ({ data: { id: '5', type: 'appStoreVersionLocalizations', attributes: { whatsNew: 'new text' } } }),
    writesEnabled: () => true,
    ...overrides,
  };
}

const locOp = () => find('PATCH', '/v1/appStoreVersionLocalizations/{id}');
const patchBody = { data: { type: 'appStoreVersionLocalizations', id: '5', attributes: { whatsNew: 'new text' } } };

test('prepare shows before/after, a tier and a ticket, and changes nothing', async () => {
  let sent = 0;
  const d = deps({
    get: async (p) =>
      p.includes('include=appStoreVersion')
        ? { data: { attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } } }
        : { data: { id: '5', type: 'appStoreVersionLocalizations', attributes: { whatsNew: 'old text' } } },
    send: async () => {
      sent++;
    },
  });
  const p = await prepareChange({ op: locOp(), pathParams: { id: '5' }, body: patchBody, deps: d });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 1);
  assert.deepEqual(p.changes, [{ field: 'whatsNew', from: 'old text', to: 'new text', unchanged: false }]);
  assert.equal(p.before.whatsNew, 'old text');
  assert.match(p.ticket, /^[0-9a-f]{18}$/);
  assert.equal(sent, 0, 'prepare must never send a change');
});

test('prepare rejects reads, mismatched ids, missing bodies and blocked operations', async () => {
  const d = deps();
  await assert.rejects(() => prepareChange({ op: find('GET', '/v1/apps'), deps: d }), /only reads data/);
  await assert.rejects(
    () => prepareChange({ op: locOp(), pathParams: { id: '5' }, body: { data: { ...patchBody.data, id: '999' } }, deps: d }),
    /must match the id in the path/,
  );
  await assert.rejects(() => prepareChange({ op: locOp(), pathParams: { id: '5' }, deps: d }), /needs a request body/);
  const del = ops().find((o) => o.method === 'DELETE');
  const blocked = await prepareChange({ op: del, pathParams: { id: '1' }, deps: d });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.tier, 3);
  assert.equal(blocked.ticket, undefined, 'blocked changes must not get a ticket');
});

test('diffAttributes flags unchanged fields', () => {
  const d = diffAttributes({ a: 1, b: 'x' }, { data: { attributes: { a: 1, b: 'y', c: true } } });
  assert.deepEqual(d.map((x) => [x.field, x.unchanged]), [['a', true], ['b', false], ['c', false]]);
});

// ---------- apply ----------

async function prepared(d, tierState = 'PREPARE_FOR_SUBMISSION') {
  const d2 = { ...d, get: async (p) => (p.includes('include=appStoreVersion') ? { data: { attributes: { appStoreState: tierState } } } : { data: { id: '5', type: 'x', attributes: { whatsNew: 'old text' } } }) };
  return { d2, p: await prepareChange({ op: locOp(), pathParams: { id: '5' }, body: patchBody, deps: d2 }) };
}

test('apply executes exactly the prepared request, once', async () => {
  const sentCalls = [];
  const base = deps({ send: async (...a) => (sentCalls.push(a), { data: { id: '5', type: 'x', attributes: { whatsNew: 'new text' } } }) });
  const { d2, p } = await prepared(base);
  const out = await applyChange({ ticketId: p.ticket, deps: d2 });
  assert.equal(out.applied, true);
  assert.deepEqual(sentCalls, [['PATCH', '/v1/appStoreVersionLocalizations/5', {}, patchBody]]);
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d2 }), /already applied/);
  assert.equal(sentCalls.length, 1, 'a ticket must never execute twice');
});

test('apply is refused when the kill switch is off, and the ticket stays usable', async () => {
  let enabled = false;
  const base = deps({ writesEnabled: () => enabled });
  const { d2, p } = await prepared(base);
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d2 }), /switched off/);
  enabled = true;
  const out = await applyChange({ ticketId: p.ticket, deps: d2 });
  assert.equal(out.applied, true);
});

test('apply_safe refuses Tier 2 tickets without consuming them', async () => {
  const base = deps();
  const d2 = { ...base, get: async () => ({ data: { attributes: { appStoreState: 'READY_FOR_SALE' } } }) };
  const p = await prepareChange({ op: locOp(), pathParams: { id: '5' }, body: patchBody, deps: d2 });
  assert.equal(p.tier, 2);
  await assert.rejects(() => applyChange({ ticketId: p.ticket, requireTier1: true, deps: d2 }), /not low-risk/);
  const out = await applyChange({ ticketId: p.ticket, requireTier1: false, deps: d2 });
  assert.equal(out.applied, true, 'the confirm-required tool can still apply it');
});

test('tickets expire, and unknown tickets are refused', async () => {
  let now = 1_000_000;
  const store = new TicketStore({ ttlMs: 600_000, now: () => now });
  const base = deps({ store });
  const { d2, p } = await prepared(base);
  now += 600_001;
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d2 }), /expired/);
  await assert.rejects(() => applyChange({ ticketId: 'nope', deps: d2 }), /Unknown ticket/);
});

test('apply re-checks safety: a version that went into review since the preview is refused', async () => {
  let state = 'PREPARE_FOR_SUBMISSION';
  const base = deps();
  const d2 = {
    ...base,
    get: async (p) => (p.includes('include=appStoreVersion') ? { data: { attributes: { appStoreState: state } } } : { data: { id: '5', type: 'x', attributes: {} } }),
  };
  const p = await prepareChange({ op: locOp(), pathParams: { id: '5' }, body: patchBody, deps: d2 });
  assert.equal(p.tier, 1);
  state = 'IN_REVIEW';
  await assert.rejects(() => applyChange({ ticketId: p.ticket, requireTier1: true, deps: d2 }), /situation changed/);
});

test('a blocked operation is reported as blocked even when its parameters are missing', async () => {
  const del = ops().find((o) => o.method === 'DELETE');
  const p = await prepareChange({ op: del, deps: deps() }); // no pathParams on purpose
  assert.equal(p.allowed, false);
  assert.equal(p.tier, 3);
  const user = ops().find((o) => o.method === 'POST' && o.path === '/v1/userInvitations');
  const u = await prepareChange({ op: user, deps: deps() }); // no body on purpose
  assert.equal(u.allowed, false);
  assert.match(u.reason, /switched off/);
});

test('every lookup path a Tier 1 rule relies on is a real GET in Apple\'s spec', () => {
  for (const rule of TIER1_IF_DRAFT) {
    const template = rule.versionPath('{id}').split('?')[0];
    assert.ok(
      ops().some((o) => o.method === 'GET' && o.path === template),
      `rule "${rule.reason}" looks up ${template}, which does not exist as a GET in the spec`,
    );
  }
  // and the PATCH it guards exists too
  for (const rule of TIER1_IF_DRAFT) {
    assert.ok(ops().some((o) => o.method === rule.method && rule.re.test(o.path.replace('{id}', 'x'))), `no ${rule.method} matches ${rule.re}`);
  }
});

test('the version state is read from an included version (the real localization response shape)', async () => {
  const loc = find('PATCH', '/v1/appStoreVersionLocalizations/{id}');
  const realShape = (state) => async () => ({
    data: { id: '5', type: 'appStoreVersionLocalizations', attributes: { locale: 'en-US' } },
    included: [{ id: 'v1', type: 'appStoreVersions', attributes: { appStoreState: state } }],
  });
  assert.equal((await classify(loc, '/v1/appStoreVersionLocalizations/5', realShape('PREPARE_FOR_SUBMISSION'))).tier, 1);
  const live = await classify(loc, '/v1/appStoreVersionLocalizations/5', realShape('READY_FOR_SALE'));
  assert.equal(live.tier, 2);
  assert.match(live.reason, /READY_FOR_SALE/, 'the reason should name the real state, not "could not confirm"');
});
