// Testers on Google Play testing tracks. Google's API manages testers only through Google Groups
// (email lists of individual testers are console-only). Changes are previews + a ticket, applied
// inside one Play edit ("testing" feature, Tier 2).
import { currentFeatures } from './rules.js';
import { prepareChange } from './writes.js';

const APP = '/androidpublisher/v3/applications';
const GROUP = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function listTesters(deps, { packageName }) {
  const pkg = packageName || deps.defaultPackage();
  return deps.withReadContext(pkg, true, async (editId) => {
    const tracks = (await deps.get(`${APP}/${pkg}/edits/${editId}/tracks`, {})).tracks || [];
    const out = [];
    for (const t of tracks.filter((x) => x.track !== 'production')) {
      try {
        const r = await deps.get(`${APP}/${pkg}/edits/${editId}/testers/${encodeURIComponent(t.track)}`, {});
        out.push({ track: t.track, googleGroups: r.googleGroups || [] });
      } catch (err) {
        out.push({ track: t.track, error: String(err.message || err) });
      }
    }
    return { app: pkg, tracks: out, note: 'Only Google Groups are managed through the API; individual tester email lists live in Play Console.' };
  });
}

export async function prepareSetTesters(deps, { packageName, track, add = [], remove = [] }) {
  if (!currentFeatures().testing) {
    return { allowed: false, tier: 3, blocked: true, reason: 'The "testing" feature is switched off in your settings. Run /hypercaffium-play:setup to see or change your settings.' };
  }
  const pkg = packageName || deps.defaultPackage();
  if (!track || track === 'production') throw new Error('Pass a testing track (internal, alpha, beta or a closed track name); production has no tester list.');
  const bad = [...add, ...remove].filter((g) => !GROUP.test(g));
  if (bad.length) throw new Error(`These are not Google Group email addresses: ${bad.join(', ')}.`);
  if (!add.length && !remove.length) throw new Error('Pass add and/or remove: Google Group email addresses.');
  const current = await deps.withReadContext(pkg, true, async (editId) => {
    const r = await deps.get(`${APP}/${pkg}/edits/${editId}/testers/${encodeURIComponent(track)}`, {});
    return r.googleGroups || [];
  });
  const lower = (x) => x.toLowerCase();
  const missing = remove.filter((g) => !current.map(lower).includes(lower(g)));
  if (missing.length) throw new Error(`Not on ${track} now, so they cannot be removed: ${missing.join(', ')}.`);
  const next = [...current.filter((g) => !remove.map(lower).includes(lower(g))), ...add.filter((g) => !current.map(lower).includes(lower(g)))];
  if (next.length === current.length && next.every((g, i) => g === current[i])) throw new Error('Nothing would change: those groups are already set that way.');
  const preview = await prepareChange({
    changes: [{ methodId: 'edits.testers.update', params: { packageName: pkg, track }, body: { googleGroups: next } }],
    deps,
  });
  return {
    track,
    adding: add.filter((g) => !current.map(lower).includes(lower(g))),
    removing: remove,
    before: current,
    after: next,
    note: 'Members of an added group can join the test from its opt-in link; members of a removed group lose access to the testing version.',
    ...preview,
  };
}
