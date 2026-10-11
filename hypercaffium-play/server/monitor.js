// Change monitor for Google Play: remember how releases and reviews looked last time,
// and say plainly what is different now. Network access is injected for testing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toLocalTime } from './util.js';

export const stateDir = () => process.env.CLAUDE_PLUGINS_STATE_DIR || path.join(os.homedir(), '.claude-plugins', 'state');
const stateFile = (name) => path.join(stateDir(), `${name}.json`);

export function loadState(name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(name), 'utf8'));
  } catch {
    return null;
  }
}

export function saveState(name, value) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(name), JSON.stringify(value, null, 1));
}

const pct = (r) => (r.status === 'completed' ? 100 : r.userFraction !== undefined ? Math.round(Number(r.userFraction) * 10000) / 100 : null);

export function snapshotFromGoogle({ packageName, tracks, reviews }) {
  const releases = {};
  for (const t of tracks || []) {
    for (const r of t.releases || []) {
      const key = `${t.track}:${r.name || (r.versionCodes || []).join('+')}`;
      releases[key] = `${r.status}|${pct(r) ?? ''}|${(r.versionCodes || []).join(',')}`;
    }
  }
  const reviewMap = {};
  for (const r of reviews || []) {
    const u = r.comments?.find((c) => c.userComment)?.userComment || {};
    reviewMap[r.reviewId] = `${u.starRating ?? '?'}|${(u.text || '').replace(/\s+/g, ' ').slice(0, 80)}`;
  }
  return { store: 'google', package: packageName, takenAt: new Date().toISOString(), releases: tracks ? releases : null, reviews: reviews ? reviewMap : null };
}

const describe = (v) => {
  const [status, percent] = v.split('|');
  return percent ? `${status} at ${percent}%` : status;
};

export function diffGoogle(prev, cur) {
  const changes = [];
  if (prev.releases && cur.releases) {
    for (const [k, now] of Object.entries(cur.releases)) {
      const [track, name] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      const was = prev.releases[k];
      if (was === undefined) changes.push({ kind: 'release:new', message: `New release on ${track}: ${name} (${describe(now)}).` });
      else if (was !== now) changes.push({ kind: 'release:changed', message: `${track} ${name}: ${describe(was)} → ${describe(now)}.` });
    }
  }
  if (prev.reviews && cur.reviews) {
    for (const [id, v] of Object.entries(cur.reviews)) {
      if (prev.reviews[id] === undefined) {
        const [stars, text] = v.split('|');
        changes.push({ kind: 'review:new', message: `New Google Play review: ${stars} star(s)${text ? ` "${text}"` : ''}.` });
      }
    }
  }
  return changes;
}

export async function googleCheckChanges({ packageName, fetchTracks, fetchReviews, save = true }) {
  const safe = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  const [tracks, reviews] = await Promise.all([safe(fetchTracks), safe(fetchReviews)]);
  const cur = snapshotFromGoogle({ packageName, tracks, reviews });
  const name = `google-play-console-${packageName}`;
  const prev = loadState(name);
  // A section we could not read this time keeps its previous baseline, so a real change is not hidden later.
  const toSave = { ...cur, releases: cur.releases ?? prev?.releases ?? null, reviews: cur.reviews ?? prev?.reviews ?? null };
  if (save) saveState(name, toSave);
  if (!prev) {
    return { store: 'google', baseline: true, message: 'First check: baseline saved. Changes will be reported from the next check on.', takenAtLocal: toLocalTime(cur.takenAt) };
  }
  const changes = diffGoogle(prev, cur);
  return {
    store: 'google',
    baseline: false,
    sinceLocal: toLocalTime(prev.takenAt),
    nowLocal: toLocalTime(cur.takenAt),
    changed: changes.length > 0,
    changes,
    note: 'Google only returns reviews from roughly the last week.',
    message: changes.length ? `${changes.length} change(s) since the last check.` : 'Nothing has changed since the last check.',
  };
}
