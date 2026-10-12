// Credentials + token handling for the App Store Connect API.
// The .p8 key itself is never copied anywhere: we only read it from the path you give us.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = path.join(os.homedir(), '.claude-plugins', 'hypercaffium-apple.json');
// Before the rename the file was called app-store-connect.json; it is still read when the new name is missing.
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.claude-plugins', 'app-store-connect.json');

// Environment variables win over the config file, so you can override per-session.
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
  const rawWrites = process.env.ASC_WRITES_ENABLED || file.writesEnabled;
  return {
    keyId: process.env.ASC_KEY_ID || file.keyId || '',
    issuerId: process.env.ASC_ISSUER_ID || file.issuerId || '',
    keyPath: process.env.ASC_KEY_PATH || file.keyPath || '',
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
  if (!cfg.keyId) problems.push('keyId is missing (the 10-character Key ID shown next to the key in App Store Connect)');
  if (!cfg.issuerId) problems.push('issuerId is missing (the UUID shown at the top of the Keys page in App Store Connect)');
  if (!cfg.keyPath) problems.push('keyPath is missing (full path to the AuthKey_XXXX.p8 file)');
  else if (!fs.existsSync(cfg.keyPath)) problems.push(`keyPath does not exist: ${cfg.keyPath}`);
  return problems;
}

const b64url = (v) => Buffer.from(v).toString('base64url');

// Apple wants an ES256 JWT that lives at most 20 minutes.
export function makeJwt({ keyId, issuerId, keyPem, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: keyPem,
    dsaEncoding: 'ieee-p1363', // raw r||s, which is what JWT ES256 requires
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

let cached = { token: '', expiresAt: 0 };

export function getToken() {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) {
    throw new Error(
      `App Store Connect is not set up yet:\n- ${problems.join('\n- ')}\nConfig file: ${CONFIG_PATH}`,
    );
  }
  const nowMs = Date.now();
  if (cached.token && nowMs < cached.expiresAt) return cached.token;
  const keyPem = fs.readFileSync(cfg.keyPath, 'utf8');
  const token = makeJwt({ keyId: cfg.keyId, issuerId: cfg.issuerId, keyPem });
  cached = { token, expiresAt: nowMs + 10 * 60 * 1000 };
  return token;
}
