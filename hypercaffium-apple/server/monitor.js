// Change monitor: remember how things looked last time, and say plainly what is different now.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flat, list, resolveApp } from './release.js';
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

// ---- Apple -----------------------------------------------------------------

export async function appleSnapshot(deps, { appId }) {
  const app = await resolveApp(deps, appId);
  const safe = async (p) => {
    try {
      return await deps.get(p);
    } catch {
      return null;
    }
  };
  const [versions, builds, subs, reviews] = await Promise.all([
    safe(`/v1/apps/${encodeURIComponent(app)}/appStoreVersions?limit=20`),
    safe(`/v1/builds?filter[app]=${encodeURIComponent(app)}&sort=-uploadedDate&limit=10`),
    safe(`/v1/apps/${encodeURIComponent(app)}/reviewSubmissions?limit=10`),
    safe(`/v1/apps/${encodeURIComponent(app)}/customerReviews?sort=-createdDate&limit=30`),
  ]);
  return {
    store: 'apple',
    app,
    takenAt: new Date().toISOString(),
    versions: versions ? Object.fromEntries(list(versions).map((v) => [`${v.platform}:${v.versionString}`, v.appStoreState || v.appVersionState])) : null,
    builds: builds ? Object.fromEntries(list(builds).map((b) => [b.version, b.processingState])) : null,
    submissions: subs ? Object.fromEntries(list(subs).map((s) => [s.id, s.state])) : null,
    reviews: reviews ? Object.fromEntries(list(reviews).map((r) => [r.id, `${r.rating}|${r.title || ''}`])) : null,
  };
}

const human = (s) => String(s).replace(/_/g, ' ').toLowerCase();

export function diffApple(prev, cur) {
  const changes = [];
  const compare = (key, label, fmt) => {
    if (!prev[key] || !cur[key]) return;
    for (const [k, now] of Object.entries(cur[key])) {
      const was = prev[key][k];
      if (was === undefined) changes.push({ kind: `${key}:new`, message: fmt.created(k, now) });
      else if (was !== now) changes.push({ kind: `${key}:changed`, message: fmt.changed(k, was, now) });
    }
  };
  compare('versions', 'version', {
    created: (k, now) => `New version ${k.split(':')[1]} appeared (${human(now)}).`,
    changed: (k, was, now) => `Version ${k.split(':')[1]}: ${human(was)} → ${human(now)}.`,
  });
  compare('builds', 'build', {
    created: (k, now) => `New build ${k} (${human(now)}).`,
    changed: (k, was, now) => `Build ${k}: ${human(was)} → ${human(now)}.`,
  });
  compare('submissions', 'submission', {
    created: (_k, now) => `A review submission was created (${human(now)}).`,
    changed: (_k, was, now) => `Review submission: ${human(was)} → ${human(now)}.`,
  });
  if (prev.reviews && cur.reviews) {
    for (const [id, v] of Object.entries(cur.reviews)) {
      if (prev.reviews[id] === undefined) {
        const [rating, title] = v.split('|');
        changes.push({ kind: 'review:new', message: `New App Store review: ${rating} star(s)${title ? ` "${title}"` : ''}.` });
      }
    }
  }
  return changes;
}

export async function appleCheckChanges(deps, { appId, save = true }) {
  const cur = await appleSnapshot(deps, { appId });
  const name = `app-store-connect-${cur.app}`;
  const prev = loadState(name);
  // A section we could not read this time keeps its previous baseline, so a real change is not hidden later.
  const keep = (k) => cur[k] ?? prev?.[k] ?? null;
  if (save) saveState(name, { ...cur, versions: keep('versions'), builds: keep('builds'), submissions: keep('submissions'), reviews: keep('reviews') });
  if (!prev) {
    return { store: 'apple', baseline: true, message: 'First check: baseline saved. Changes will be reported from the next check on.', takenAtLocal: toLocalTime(cur.takenAt) };
  }
  const changes = diffApple(prev, cur);
  return {
    store: 'apple',
    baseline: false,
    sinceLocal: toLocalTime(prev.takenAt),
    nowLocal: toLocalTime(cur.takenAt),
    changed: changes.length > 0,
    changes,
    message: changes.length ? `${changes.length} change(s) since the last check.` : 'Nothing has changed since the last check.',
  };
}

export { flat };
