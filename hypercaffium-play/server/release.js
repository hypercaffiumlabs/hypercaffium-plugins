// Google Play release workflows. Each one only PREPARES a previewed, ticketed change (Tier 2);
// nothing happens until play_apply_change runs with the ticket. Network access is injected for testing.
import { prepareChange } from './writes.js';

const APP = '/androidpublisher/v3/applications';
export const NOTE_MAX = 500; // Play's limit per language
const TRACK = /^[A-Za-z0-9_-]{1,40}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const STATUSES = ['draft', 'inProgress', 'completed', 'halted'];

function pkgOf(deps, packageName) {
  const pkg = packageName || deps.defaultPackage();
  if (!pkg || !/^[A-Za-z0-9._]+$/.test(pkg)) throw new Error('A valid packageName is required (or set defaultPackageName in the config file).');
  return pkg;
}

async function readTrack(deps, pkg, track) {
  if (!TRACK.test(track || '')) throw new Error(`"${track}" is not a valid track name (internal, alpha, beta, production, or a custom track).`);
  try {
    const t = await deps.withReadContext(pkg, true, (editId) => deps.get(`${APP}/${pkg}/edits/${editId}/tracks/${track}`, {}));
    return { track: t.track || track, releases: t.releases || [] };
  } catch (err) {
    throw new Error(`Could not read the "${track}" track: ${err.message}`);
  }
}

async function readVersionCodes(deps, pkg) {
  const b = await deps.withReadContext(pkg, true, (editId) => deps.get(`${APP}/${pkg}/edits/${editId}/bundles`, {}));
  return (b.bundles || []).map((x) => Number(x.versionCode)).filter((n) => Number.isInteger(n));
}

export function checkNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) throw new Error('Provide releaseNotes: a list of {language, text}.');
  const seen = new Set();
  for (const n of notes) {
    // text '' is how Google Play clears a language's note (leaving releaseNotes out means "leave as is").
    if (!n || typeof n.text !== 'string') throw new Error('Every release note needs text (use an empty string to clear that language).');
    if (!LANG.test(n.language || '')) throw new Error(`"${n.language}" is not a language code like en-US.`);
    if (n.text.length > NOTE_MAX) throw new Error(`The ${n.language} note is ${n.text.length} characters; Google Play allows at most ${NOTE_MAX}.`);
    if (seen.has(n.language)) throw new Error(`Language ${n.language} appears twice.`);
    seen.add(n.language);
  }
  return notes.map((n) => ({ language: n.language, text: n.text }));
}

const sameCodes = (a, b) => JSON.stringify((a.versionCodes || []).map(String).sort()) === JSON.stringify((b.versionCodes || []).map(String).sort());
const pct = (r) => (r.status === 'completed' ? 100 : r.userFraction !== undefined ? Math.round(Number(r.userFraction) * 10000) / 100 : null);
const describeRelease = (r) => (r ? { name: r.name, status: r.status, versionCodes: (r.versionCodes || []).map(Number), rolloutPercent: pct(r) } : null);

// ---- set a release ---------------------------------------------------------

export async function prepareSetRelease(deps, { packageName, track, versionCodes, status, userFraction, releaseNotes, name }) {
  const pkg = pkgOf(deps, packageName);
  if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(', ')}.`);
  if (!Array.isArray(versionCodes) || versionCodes.length === 0 || !versionCodes.every((v) => Number.isInteger(v) && v > 0)) {
    throw new Error('versionCodes must be a list of positive whole numbers, e.g. [6].');
  }
  if (status === 'inProgress') {
    if (typeof userFraction !== 'number' || !(userFraction > 0 && userFraction < 1)) {
      throw new Error('A staged rollout (inProgress) needs userFraction between 0 and 1, exclusive (e.g. 0.1 for 10%).');
    }
  } else if (userFraction !== undefined && status !== 'halted') {
    throw new Error(`userFraction only applies to inProgress or halted releases (status is ${status}).`);
  }
  const notes = releaseNotes === undefined ? undefined : checkNotes(releaseNotes);

  // One at a time: Google keeps a single open edit per app, and a second one discards the first.
  const current = await readTrack(deps, pkg, track);
  const available = await readVersionCodes(deps, pkg);
  const missing = versionCodes.filter((v) => !available.includes(v));
  if (missing.length) {
    throw new Error(`Version code(s) ${missing.join(', ')} have not been uploaded to Google Play. Uploaded: ${available.sort((a, b) => a - b).join(', ') || 'none'}. (Builds arrive from EAS.)`);
  }
  const release = { status, versionCodes: versionCodes.map(String) };
  if (name) release.name = name;
  if (status === 'inProgress' || status === 'halted') if (userFraction !== undefined) release.userFraction = userFraction;
  if (notes) release.releaseNotes = notes;

  // Keep the completed release that keeps serving everyone outside a staged rollout; anything else
  // currently on the track that this release does not restate is replaced, and we say so.
  const keep = current.releases.filter((r) => r.status === 'completed' && status !== 'completed' && !sameCodes(r, release));
  const replaced = current.releases.filter((r) => !keep.includes(r) && !sameCodes(r, release));
  const preview = await prepareChange({
    changes: [{ methodId: 'edits.tracks.update', params: { track, packageName: pkg }, body: { track, releases: [release, ...keep] } }],
    deps,
  });
  if (!preview.allowed) return preview;
  return {
    ...preview,
    summary: {
      track,
      willBe: describeRelease(release),
      keepsServing: keep.map(describeRelease),
      replaces: replaced.map(describeRelease),
      currentlyOnTrack: current.releases.map(describeRelease),
      reachesRealUsers: track === 'production',
      note:
        track === 'production'
          ? 'This is the production track: it reaches real users. Google keeps serving the previous completed release to everyone outside a staged rollout.'
          : 'A testing track: only testers on this track receive it.',
    },
  };
}

// ---- rollout controls ------------------------------------------------------

export async function prepareRollout(deps, { packageName, track = 'production', action, userFraction }) {
  const pkg = pkgOf(deps, packageName);
  const ACTIONS = ['increase', 'halt', 'resume', 'complete'];
  if (!ACTIONS.includes(action)) throw new Error(`action must be one of: ${ACTIONS.join(', ')}.`);
  const t = await readTrack(deps, pkg, track);
  const active = t.releases.find((r) => r.status === 'inProgress') || t.releases.find((r) => r.status === 'halted');
  if (!active) throw new Error(`There is no staged rollout in progress or halted on "${track}".`);
  const current = Number(active.userFraction);
  let next;
  if (action === 'increase') {
    if (active.status !== 'inProgress') throw new Error(`The rollout is ${active.status}; resume it before increasing.`);
    if (typeof userFraction !== 'number' || !(userFraction > current && userFraction < 1)) {
      throw new Error(`userFraction must be above the current ${pct(active)}% and below 100% (use "complete" for everyone). Got ${userFraction}.`);
    }
    next = { ...active, userFraction };
  } else if (action === 'halt') {
    if (active.status !== 'inProgress') throw new Error(`Only an in-progress rollout can be halted (it is ${active.status}).`);
    next = { ...active, status: 'halted' };
  } else if (action === 'resume') {
    if (active.status !== 'halted') throw new Error(`Only a halted rollout can be resumed (it is ${active.status}).`);
    next = { ...active, status: 'inProgress' };
  } else {
    next = { ...active, status: 'completed' };
    delete next.userFraction;
  }
  // Send the whole current list with only the intended change. Completing makes this release the one
  // everyone gets, so it replaces the older completed release; every other action keeps the baseline.
  const others = t.releases.filter((r) => r !== active);
  const releases = action === 'complete' ? [next] : [next, ...others];
  const preview = await prepareChange({
    changes: [{ methodId: 'edits.tracks.update', params: { track, packageName: pkg }, body: { track, releases } }],
    deps,
  });
  if (!preview.allowed) return preview;
  return {
    ...preview,
    summary: {
      track,
      action,
      keepsServing: action === 'complete' ? [] : others.map(describeRelease),
      version: (active.versionCodes || []).join(','),
      from: { status: active.status, rolloutPercent: pct(active) },
      to: { status: next.status, rolloutPercent: pct(next) },
      reminder:
        action === 'increase' || action === 'resume'
          ? 'Your ramp plan is 10% then 50% then 100%, with a 48-hour Sentry and Android Vitals check between steps.'
          : undefined,
    },
  };
}

// ---- promote ---------------------------------------------------------------

export async function preparePromote(deps, { packageName, fromTrack = 'internal', toTrack, userFraction, releaseNotes }) {
  const pkg = pkgOf(deps, packageName);
  if (!toTrack) throw new Error('Pass toTrack (alpha, beta or production).');
  if (fromTrack === toTrack) throw new Error('fromTrack and toTrack are the same.');
  const src = await readTrack(deps, pkg, fromTrack);
  const rel = src.releases.find((r) => r.status === 'completed') || src.releases.find((r) => r.status === 'inProgress');
  if (!rel) throw new Error(`There is no completed or in-progress release on "${fromTrack}" to promote.`);
  const notes = releaseNotes !== undefined ? releaseNotes : rel.releaseNotes;
  const versionCodes = (rel.versionCodes || []).map(Number);
  let status = 'completed';
  let fraction;
  if (toTrack === 'production') {
    fraction = userFraction === undefined ? 0.1 : userFraction;
    if (fraction >= 1) {
      status = 'completed';
      fraction = undefined;
    } else {
      status = 'inProgress';
    }
  }
  const preview = await prepareSetRelease(deps, {
    packageName: pkg,
    track: toTrack,
    versionCodes,
    status,
    userFraction: fraction,
    releaseNotes: notes && notes.length ? notes.map((n) => ({ language: n.language, text: n.text })) : undefined,
  });
  if (!preview.allowed) return preview;
  return { ...preview, promotedFrom: { track: fromTrack, release: describeRelease(rel) } };
}

// ---- release notes ---------------------------------------------------------

export async function prepareReleaseNotes(deps, { packageName, track = 'production', releaseNotes }) {
  const pkg = pkgOf(deps, packageName);
  const notes = checkNotes(releaseNotes);
  const t = await readTrack(deps, pkg, track);
  const open = t.releases.find((r) => r.status === 'draft') || t.releases.find((r) => r.status === 'inProgress') || t.releases.find((r) => r.status === 'halted');
  if (!open) {
    throw new Error(`The "${track}" track has no draft, in-progress or halted release. Google does not allow changing the notes of a completed release; set up a new release with play_set_release.`);
  }
  const next = { ...open, releaseNotes: notes };
  const preview = await prepareChange({
    changes: [{ methodId: 'edits.tracks.update', params: { track, packageName: pkg }, body: { track, releases: t.releases.map((r) => (r === open ? next : r)) } }],
    deps,
  });
  if (!preview.allowed) return preview;
  return {
    ...preview,
    summary: {
      track,
      release: describeRelease(open),
      before: (open.releaseNotes || []).map((n) => ({ language: n.language, text: n.text })),
      after: notes,
    },
  };
}
