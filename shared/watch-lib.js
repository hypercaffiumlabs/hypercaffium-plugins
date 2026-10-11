// Pure helpers for the scheduled store watcher (kept free of network and OS calls so they can be tested).

export const ERROR_TOAST_EVERY_MS = 24 * 60 * 60 * 1000;

export const STORE_TITLE = { apple: 'App Store', google: 'Google Play' };

// Importance, so the most important change leads the notification.
export function priority(message) {
  const m = message.toLowerCase();
  if (/reject|unresolved|invalid|failed|halted/.test(m)) return 0;
  if (/ star\(s\)/.test(m) && /\b[12] star/.test(m)) return 1;
  if (/→|new version|new release|new build/.test(m)) return 2;
  return 3;
}

export function formatToast(store, changes, { max = 3 } = {}) {
  const sorted = [...changes].sort((a, b) => priority(a.message) - priority(b.message));
  const lines = sorted.slice(0, max).map((c) => c.message);
  if (sorted.length > max) lines.push(`...and ${sorted.length - max} more.`);
  return { title: `${STORE_TITLE[store] || store}`, body: lines.join('\n') };
}

// Tell the user about a persistent problem at most once a day per store, never every 30 minutes.
export function shouldNotifyError(meta, store, now = Date.now()) {
  const last = meta?.errorToastAt?.[store];
  return !last || now - last >= ERROR_TOAST_EVERY_MS;
}

export function markErrorNotified(meta, store, now = Date.now()) {
  return { ...meta, errorToastAt: { ...(meta?.errorToastAt || {}), [store]: now } };
}

export function clearError(meta, store) {
  const next = { ...(meta?.errorToastAt || {}) };
  delete next[store];
  return { ...meta, errorToastAt: next };
}

// One plain line per store for the log file.
export function logLine(result, nowIso = new Date().toISOString()) {
  if (result.error) return `${nowIso} ${result.store}: ERROR ${result.error}`;
  if (result.baseline) return `${nowIso} ${result.store}: baseline saved`;
  if (!result.changed) return `${nowIso} ${result.store}: no change`;
  return `${nowIso} ${result.store}: ${result.changes.length} change(s): ${result.changes.map((c) => c.message).join(' | ')}`;
}
