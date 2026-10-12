process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSetRelease } from './release.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';
function fake(trackAt) {
  const calls = [];
  let phase = 'prepare';
  return {
    calls,
    setPhase: (x) => (phase = x),
    store: new TicketStore(),
    defaultPackage: () => PKG,
    writesEnabled: () => true,
    withReadContext: async (_p, needsEdit, fn) => fn(needsEdit ? 'E0' : null),
    get: async (p) => {
      if (p.endsWith('/bundles')) return { bundles: [{ versionCode: 6 }, { versionCode: 7 }, { versionCode: 8 }] };
      if (p.includes('/tracks/')) return { track: 'production', releases: trackAt[phase] };
      throw new Error(`fake: no GET ${p}`);
    },
    send: async (method, p, _q, body) => {
      calls.push([method, p, body]);
      if (method === 'POST' && p.endsWith('/edits')) return { id: 'E1' };
      return {};
    },
  };
}

test('a release change stops if the track changed between the preview and the apply', async () => {
  const d = fake({
    prepare: [{ status: 'completed', versionCodes: ['6'] }],
    apply: [{ status: 'inProgress', versionCodes: ['8'], userFraction: 0.2 }, { status: 'completed', versionCodes: ['6'] }],
  });
  const p = await prepareSetRelease(d, { track: 'production', versionCodes: [7], status: 'completed' });
  d.setPhase('apply');
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /changed since the preview/);
  assert.ok(!d.calls.some((c) => c[0] === 'PUT'), 'the track was never written');
  assert.ok(!d.calls.some((c) => String(c[1]).endsWith(':commit')), 'nothing was committed');
  assert.ok(d.calls.some((c) => c[0] === 'DELETE'), 'the edit was discarded');
});

test('an unchanged track goes through as previewed', async () => {
  const same = [{ status: 'completed', versionCodes: ['6'] }];
  const d = fake({ prepare: same, apply: same });
  const p = await prepareSetRelease(d, { track: 'production', versionCodes: [7], status: 'completed' });
  d.setPhase('apply');
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, true);
});
