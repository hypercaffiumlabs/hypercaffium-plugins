// Read-only App Store Connect client (HTTP GET only). Shared by the MCP server and the scheduled watcher.
import { getToken } from './auth.js';

export const API_ORIGIN = 'https://api.appstoreconnect.apple.com';

// Defence in depth: the bearer token is only ever sent to Apple's API host, whatever a caller passes in.
export function assertApiUrl(url) {
  if (url.origin !== API_ORIGIN || !/^\/v[123]\//.test(url.pathname)) {
    throw new Error(`Refusing to send credentials to ${url.origin}${url.pathname}: not an App Store Connect API address.`);
  }
}

export async function ascGetUrl(url) {
  assertApiUrl(url);
  const res = await fetch(url, {
    method: 'GET', // the ONLY method this server uses in phase 2a
    headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body.errors || []).map((e) => `${e.status} ${e.title}: ${e.detail}`).join('; ');
    throw new Error(`Apple API ${res.status} for ${url.pathname}${detail ? ` -> ${detail}` : ''}`);
  }
  return body;
}

export async function ascGet(pathname, query = {}) {
  const url = new URL(pathname, API_ORIGIN);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return ascGetUrl(url);
}
