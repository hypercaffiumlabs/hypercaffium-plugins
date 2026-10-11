process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNotes, prepareReleaseNotes, preparePromote, prepareRollout, prepareSetRelease } from './release.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';

// A fake Google Play: tracks and bundles live in plain objects.
function fakePlay({ tracks, bundles = [5, 6], enabled = true } = {}) {
  const calls = [];
  const trackGet = (name) => tracks.find((t) => t.track === name) || { track: name, releases: [] };
  const deps = {
    calls,
    store: new TicketStore(),
    defaultPackage: () => PKG,
    writesEnabled: () => enabled,
    withReadContext: async (_p, needsEdit, fn) => fn(needsEdit ? 'E0' : null),
    get: async (path) => {
      if (path.endsWith('/bundles')) return { bundles: bundles.map((versionCode) => ({ versionCode })) };
      const m = /\/tracks\/([^/]+)$/.exec(path);
      if (m) return trackGet(m[1]);
      throw new Error(`fake: no GET ${path}`);
    },
    send: async (method, path, _q, body) => {
      calls.push({ method, path, body });
      if (method === 'POST' && path.endsWith('/edits')) return { id: 'E1' };
      if (path.endsWith(':commit')) return { id: 'E1', expiryTimeSeconds: '1' };
      return { ok: true };
    },
  };
  return deps;
}

const prod = (releases) => ({ track: 'production', releases });
const note = (text) => [{ language: 'en-US', text }];

test('release notes are validated (language, length, duplicates)', () => {
  assert.deepEqual(checkNotes(note('Fixes')), [{ language: 'en-US', text: 'Fixes' }]);
  assert.throws(() => checkNotes([{ language: 'en-US', text: 'x'.repeat(501) }]), /at most 500/);
  assert.throws(() => checkNotes([{ language: 'english', text: 'x' }]), /language code/);
  assert.throws(() => checkNotes([{ language: 'en-US', text: 'a' }, { language: 'en-US', text: 'b' }]), /twice/);
  assert.throws(() => checkNotes([]), /Provide releaseNotes/);
});

test('set release: a 10% production rollout previews as Tier 2 and applies as one committed edit', async () => {
  const d = fakePlay({ tracks: [prod([{ name: '1.1.3', status: 'completed', versionCodes: ['5'] }])] });
  const p = await prepareSetRelease(d, { track: 'production', versionCodes: [6], status: 'inProgress', userFraction: 0.1, releaseNotes: note('Hive colors') });
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.equal(p.summary.reachesRealUsers, true);
  assert.equal(p.summary.willBe.rolloutPercent, 10);
  assert.equal(p.summary.currentlyOnTrack[0].name, '1.1.3');
  assert.equal(d.calls.length, 0, 'preview must not send anything');

  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.committed, true);
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.path.replace(PKG, 'PKG').replace('/androidpublisher/v3/applications/', '')}`), [
    'POST PKG/edits',
    'PUT PKG/edits/E1/tracks/production',
    'POST PKG/edits/E1:commit',
  ]);
  assert.deepEqual(d.calls[1].body, {
    track: 'production',
    releases: [
      { status: 'inProgress', versionCodes: ['6'], userFraction: 0.1, releaseNotes: [{ language: 'en-US', text: 'Hive colors' }] },
      { name: '1.1.3', status: 'completed', versionCodes: ['5'] }, // the baseline keeps serving everyone else
    ],
  });
  assert.deepEqual(p.summary.keepsServing.map((r) => r.name), ['1.1.3']);
  assert.deepEqual(p.summary.replaces, []);
});

test('set release: rejects bad fractions, statuses, and version codes that were never uploaded', async () => {
  const d = fakePlay({ tracks: [] });
  await assert.rejects(() => prepareSetRelease(d, { track: 'production', versionCodes: [6], status: 'inProgress' }), /userFraction between 0 and 1/);
  await assert.rejects(() => prepareSetRelease(d, { track: 'production', versionCodes: [6], status: 'inProgress', userFraction: 1 }), /between 0 and 1/);
  await assert.rejects(() => prepareSetRelease(d, { track: 'production', versionCodes: [6], status: 'completed', userFraction: 0.5 }), /only applies to inProgress/);
  await assert.rejects(() => prepareSetRelease(d, { track: 'production', versionCodes: [6], status: 'live' }), /status must be one of/);
  await assert.rejects(() => prepareSetRelease(d, { track: 'production', versionCodes: [99], status: 'completed' }), /have not been uploaded.*5, 6/s);
  await assert.rejects(() => prepareSetRelease(d, { track: 'pro duction', versionCodes: [6], status: 'completed' }), /not a valid track/);
});

test('rollout: increase, halt, resume, complete move the right fields; invalid moves are refused', async () => {
  const inProgress = fakePlay({ tracks: [prod([{ name: '1.1.4', status: 'inProgress', userFraction: 0.1, versionCodes: ['6'] }])] });
  const up = await prepareRollout(inProgress, { action: 'increase', userFraction: 0.5 });
  assert.deepEqual([up.summary.from.rolloutPercent, up.summary.to.rolloutPercent], [10, 50]);
  assert.match(up.summary.reminder, /48-hour/);
  await assert.rejects(() => prepareRollout(inProgress, { action: 'increase', userFraction: 0.05 }), /above the current 10%/);
  await assert.rejects(() => prepareRollout(inProgress, { action: 'increase', userFraction: 1 }), /below 100%/);
  await assert.rejects(() => prepareRollout(inProgress, { action: 'resume' }), /Only a halted rollout/);

  const halt = await prepareRollout(inProgress, { action: 'halt' });
  assert.equal(halt.changes[0].requestBody.releases[0].status, 'halted');

  const halted = fakePlay({ tracks: [prod([{ name: '1.1.4', status: 'halted', userFraction: 0.1, versionCodes: ['6'] }])] });
  const resume = await prepareRollout(halted, { action: 'resume' });
  assert.equal(resume.changes[0].requestBody.releases[0].status, 'inProgress');
  await assert.rejects(() => prepareRollout(halted, { action: 'increase', userFraction: 0.5 }), /resume it before increasing/);

  const done = await prepareRollout(inProgress, { action: 'complete' });
  const rel = done.changes[0].requestBody.releases[0];
  assert.equal(rel.status, 'completed');
  assert.equal('userFraction' in rel, false, 'a completed release must not carry a fraction');

  await assert.rejects(() => prepareRollout(fakePlay({ tracks: [prod([{ name: 'x', status: 'completed', versionCodes: ['5'] }])] }), { action: 'halt' }), /no staged rollout/);
});

test('promote: internal to production defaults to a 10% staged rollout and carries release notes', async () => {
  const d = fakePlay({
    tracks: [
      { track: 'internal', releases: [{ name: '1.1.4', status: 'completed', versionCodes: ['6'], releaseNotes: note('Faster sync') }] },
      prod([{ name: '1.1.3', status: 'completed', versionCodes: ['5'] }]),
    ],
  });
  const p = await preparePromote(d, { toTrack: 'production' });
  assert.equal(p.summary.willBe.rolloutPercent, 10);
  assert.equal(p.changes[0].requestBody.releases[0].releaseNotes[0].text, 'Faster sync');
  assert.equal(p.promotedFrom.track, 'internal');

  const everyone = await preparePromote(d, { toTrack: 'production', userFraction: 1 });
  assert.equal(everyone.changes[0].requestBody.releases[0].status, 'completed');

  const beta = await preparePromote(d, { toTrack: 'beta' });
  assert.equal(beta.changes[0].requestBody.releases[0].status, 'completed');

  await assert.rejects(() => preparePromote(d, { toTrack: 'internal' }), /same/);
  await assert.rejects(() => preparePromote(fakePlay({ tracks: [] }), { toTrack: 'production' }), /no completed or in-progress release on "internal"/);
});

test('release notes: only open releases can be changed, and the diff is shown', async () => {
  const d = fakePlay({ tracks: [prod([{ name: '1.1.4', status: 'inProgress', userFraction: 0.1, versionCodes: ['6'], releaseNotes: note('old') }])] });
  const p = await prepareReleaseNotes(d, { releaseNotes: note('new text') });
  assert.equal(p.summary.before[0].text, 'old');
  assert.equal(p.summary.after[0].text, 'new text');
  assert.equal(p.tier, 2);
  const completedOnly = fakePlay({ tracks: [prod([{ name: '1.1.3', status: 'completed', versionCodes: ['5'] }])] });
  await assert.rejects(() => prepareReleaseNotes(completedOnly, { releaseNotes: note('x') }), /completed release/);
});

test('the kill switch still guards every release change', async () => {
  const d = fakePlay({ tracks: [prod([])], enabled: false });
  const p = await prepareSetRelease(d, { track: 'internal', versionCodes: [6], status: 'completed' });
  await assert.rejects(() => applyChange({ ticketId: p.ticket, deps: d }), /switched off/);
  assert.equal(d.calls.length, 0);
});

test('rollout from a real two-release track keeps the baseline; complete replaces it', async () => {
  const tracks = [prod([
    { name: '6 (1.1.4)', status: 'inProgress', userFraction: 0.1, versionCodes: ['6'], releaseNotes: note('Top Bar') },
    { name: '1.1.3', status: 'completed', versionCodes: ['5'] },
  ])];
  const up = await prepareRollout(fakePlay({ tracks }), { action: 'increase', userFraction: 0.5 });
  const rel = up.changes[0].requestBody.releases;
  assert.deepEqual(rel.map((r) => [r.name, r.status, r.userFraction]), [['6 (1.1.4)', 'inProgress', 0.5], ['1.1.3', 'completed', undefined]]);
  assert.equal(rel[0].releaseNotes[0].text, 'Top Bar', 'release notes must survive a rollout change');

  const done = await prepareRollout(fakePlay({ tracks }), { action: 'complete' });
  assert.deepEqual(done.changes[0].requestBody.releases.map((r) => [r.name, r.status]), [['6 (1.1.4)', 'completed']]);
});

test('set release over an existing rollout says what it replaces', async () => {
  const d = fakePlay({
    tracks: [prod([{ name: '6 (1.1.4)', status: 'inProgress', userFraction: 0.1, versionCodes: ['6'] }, { name: '1.1.3', status: 'completed', versionCodes: ['5'] }])],
    bundles: [5, 6, 7],
  });
  const p = await prepareSetRelease(d, { track: 'production', versionCodes: [7], status: 'inProgress', userFraction: 0.1 });
  assert.deepEqual(p.summary.replaces.map((r) => r.name), ['6 (1.1.4)']);
  assert.deepEqual(p.summary.keepsServing.map((r) => r.name), ['1.1.3']);
});

test('reads for a preview never overlap (Google allows one open edit)', async () => {
  const d = fakePlay({ tracks: [prod([{ name: '1.1.3', status: 'completed', versionCodes: ['5'] }])] });
  let open = 0;
  let maxOpen = 0;
  const inner = d.withReadContext;
  d.withReadContext = async (...args) => {
    open++;
    maxOpen = Math.max(maxOpen, open);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await inner(...args);
    } finally {
      open--;
    }
  };
  await prepareSetRelease(d, { track: 'production', versionCodes: [6], status: 'completed' });
  await preparePromote(
    fakePlay({ tracks: [{ track: 'internal', releases: [{ name: 'a', status: 'completed', versionCodes: ['6'] }] }, prod([])] }),
    { toTrack: 'production' },
  );
  assert.equal(maxOpen, 1, 'two edits were open at once');
});

test('release notes: an empty text clears a language, and leaving notes out keeps them (verified live on Play)', async () => {
  assert.deepEqual(checkNotes([{ language: 'en-US', text: '' }]), [{ language: 'en-US', text: '' }]);
  const d = fakePlay({ tracks: [{ track: 'internal', releases: [{ name: '1.1.4', status: 'completed', versionCodes: ['6'], releaseNotes: note('temp') }] }] });
  const clear = await prepareSetRelease(d, { track: 'internal', versionCodes: [6], status: 'completed', name: '1.1.4', releaseNotes: [{ language: 'en-US', text: '' }] });
  assert.deepEqual(clear.changes[0].requestBody.releases[0].releaseNotes, [{ language: 'en-US', text: '' }]);
  const keep = await prepareSetRelease(d, { track: 'internal', versionCodes: [6], status: 'completed', name: '1.1.4' });
  assert.equal('releaseNotes' in keep.changes[0].requestBody.releases[0], false, 'no notes key means Play keeps the existing notes');
});
