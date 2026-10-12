// Read-only Google Play client (GET, plus the temporary empty edit that reads require).
// Shared by the MCP server and the scheduled watcher. assertAllowed() refuses anything that could change data.
import { getAccessToken } from './auth.js';
import { assertAllowed } from './guard.js';

export const API_ORIGIN = 'https://androidpublisher.googleapis.com';
export const APP_BASE = '/androidpublisher/v3/applications';

// body: only for the read-only POSTs the guard allows (an empty edit, or a price conversion).
export async function playRequest(method, pathname, query = {}, body) {
  assertAllowed(method, pathname); // refuse anything that is not provably read-only
  const url = new URL(pathname, API_ORIGIN);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { Authorization: `Bearer ${await getAccessToken()}`, Accept: 'application/json' };
  const init = { method, headers };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = body ? JSON.stringify(body) : '{}'; // empty edit, or a price-conversion request
  }
  const res = await fetch(url, init);
  if (method === 'DELETE' && res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(`Google Play API ${res.status} for ${url.pathname}: ${e.message || e.status || 'unknown error'}`);
  }
  return json;
}

// Open a temporary edit, run the read, always delete the edit again.
export async function withTemporaryEdit(pkg, fn) {
  const edit = await playRequest('POST', `${APP_BASE}/${pkg}/edits`);
  try {
    return await fn(edit.id);
  } finally {
    await playRequest('DELETE', `${APP_BASE}/${pkg}/edits/${edit.id}`).catch(() => {});
  }
}
