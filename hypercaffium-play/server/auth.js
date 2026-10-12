// Credentials + token handling for the Google Play Developer API.
// The service-account JSON key is only read from the path you give us, never copied.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = path.join(os.homedir(), '.claude-plugins', 'hypercaffium-play.json');
// Before the rename the file was called google-play-console.json; it is still read when the new name is missing.
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.claude-plugins', 'google-play-console.json');
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// Environment variables win over the config file.
export function loadConfig() {
  let file = {};
  let fileError = '';
  try {
    file = JSON.parse(fs.readFileSync(fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH, 'utf8'));
  } catch (err) {
    // A missing file is fine (env vars may be set instead); a broken file is not.
    if (err.code !== 'ENOENT') fileError = `${CONFIG_PATH} could not be read: ${err.message}`;
  }
  // The kill switch. Writes are OFF unless this is explicitly turned on.
  const rawWrites = process.env.PLAY_WRITES_ENABLED || file.writesEnabled;
  return {
    serviceAccountKeyPath: process.env.PLAY_SA_KEY_PATH || file.serviceAccountKeyPath || '',
    defaultPackageName: process.env.PLAY_PACKAGE_NAME || file.defaultPackageName || '',
    writesEnabled: rawWrites === true || /^(1|true|yes)$/i.test(String(rawWrites || '')),
    timezone: process.env.HYPERCAFFIUM_TIMEZONE || file.timezone || '',
    // Feature switches (see shared/features.js); missing ones fall back to their defaults.
    features: file.features && typeof file.features === 'object' ? file.features : {},
    // True once the setup menu has saved settings at least once.
    configured: Boolean(file.features),
    fileError,
  };
}

export function configProblems(cfg) {
  const problems = [];
  if (cfg.fileError) problems.push(`${cfg.fileError} (in JSON files, every backslash in a path must be doubled: C:\\\\Users\\\\...)`);
  if (!cfg.serviceAccountKeyPath) problems.push('serviceAccountKeyPath is missing (full path to the service-account .json key file)');
  else if (!fs.existsSync(cfg.serviceAccountKeyPath)) problems.push(`serviceAccountKeyPath does not exist: ${cfg.serviceAccountKeyPath}`);
  return problems;
}

const b64url = (v) => Buffer.from(v).toString('base64url');

// Google wants an RS256 JWT, exchanged at the token endpoint for a 1-hour access token.
export function makeAssertion({ clientEmail, privateKeyPem, tokenUri, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: clientEmail, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), privateKeyPem);
  return `${input}.${sig.toString('base64url')}`;
}

let cached = { token: '', expiresAt: 0 };

export async function getAccessToken() {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) {
    throw new Error(`Google Play is not set up yet:\n- ${problems.join('\n- ')}\nConfig file: ${CONFIG_PATH}`);
  }
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  const sa = JSON.parse(fs.readFileSync(cfg.serviceAccountKeyPath, 'utf8'));
  // Only Google's own token endpoint is trusted, so a tampered key file cannot redirect the signed request.
  const tokenUri = /^https:\/\/oauth2\.googleapis\.com\//.test(sa.token_uri || '') ? sa.token_uri : 'https://oauth2.googleapis.com/token';
  const assertion = makeAssertion({ clientEmail: sa.client_email, privateKeyPem: sa.private_key, tokenUri });
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token request failed (${res.status}): ${body.error_description || body.error || 'unknown error'}`);
  }
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 120) * 1000 };
  return cached.token;
}
