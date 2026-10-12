process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setFeatureSource } from './rules.js';
import { listTesters, prepareSetTesters } from './testers.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';
function fake(groups = ['beta-crew@googlegroups.com']) {
  const calls = [];
  return {
    calls,
    store: new TicketStore(),
    defaultPackage: () => PKG,
    writesEnabled: () => true,
    withReadContext: async (_p, needsEdit, fn) => fn(needsEdit ? 'E0' : null),
    get: async (p) => {
      if (p.endsWith('/tracks')) return { tracks: [{ track: 'production' }, { track: 'internal' }, { track: 'beta' }] };
      if (p.includes('/testers/')) return { googleGroups: groups };
      throw new Error(`fake: no GET ${p}`);
    },
    send: async (method, p, _q, body) => {
      calls.push([method, p, body]);
      if (method === 'POST' && p.endsWith('/edits')) return { id: 'E1' };
      return {};
    },
  };
}
afterEach(() => setFeatureSource(() => ({})));

test('list testers skips production and lists the groups of each testing track', async () => {
  const r = await listTesters(fake(), {});
  assert.deepEqual(r.tracks.map((t) => t.track), ['internal', 'beta']);
  assert.deepEqual(r.tracks[0].googleGroups, ['beta-crew@googlegroups.com']);
});

test('set testers: shows before and after, and commits the new list inside one edit', async () => {
  const d = fake();
  const p = await prepareSetTesters(d, { track: 'beta', add: ['hive-club@googlegroups.com'], remove: ['beta-crew@googlegroups.com'] });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.equal(p.feature, 'testing');
  assert.deepEqual(p.after, ['hive-club@googlegroups.com']);
  await applyChange({ ticketId: p.ticket, deps: d });
  const put = d.calls.find((c) => c[0] === 'PUT');
  assert.match(put[1], /\/edits\/E1\/testers\/beta$/);
  assert.deepEqual(put[2], { googleGroups: ['hive-club@googlegroups.com'] });
  assert.ok(d.calls.some((c) => c[1].endsWith(':commit')));
});

test('set testers: refuses production, non-group addresses, unknown removals and no-op changes', async () => {
  const d = fake();
  await assert.rejects(prepareSetTesters(d, { track: 'production', add: ['a@googlegroups.com'] }), /production/);
  await assert.rejects(prepareSetTesters(d, { track: 'beta', add: ['not-an-email'] }), /not Google Group/);
  await assert.rejects(prepareSetTesters(d, { track: 'beta', remove: ['other@googlegroups.com'] }), /cannot be removed/);
  await assert.rejects(prepareSetTesters(d, { track: 'beta', add: ['beta-crew@googlegroups.com'] }), /Nothing would change/);
});

test('set testers is refused when the testing feature is off', async () => {
  setFeatureSource(() => ({ testing: false }));
  const p = await prepareSetTesters(fake(), { track: 'beta', add: ['a@googlegroups.com'] });
  assert.equal(p.allowed, false);
});
