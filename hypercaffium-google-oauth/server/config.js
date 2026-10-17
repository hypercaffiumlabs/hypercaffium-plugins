// Settings for the Google OAuth plugin, read from ~/.claude-plugins/hypercaffium-google-oauth.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFeatures } from '../../shared/features.js';

export const PLUGIN = 'hypercaffium-google-oauth';
export const CONFIG_PATH = path.join(os.homedir(), '.claude-plugins', `${PLUGIN}.json`);
export const RECIPES_DIR = path.join(os.homedir(), '.claude-plugins', PLUGIN, 'recipes');
// Google Cloud project ids: 6 to 30 characters, lowercase letters, digits and hyphens.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

function readSettingsFile(file) {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON, so the settings could not be read: ${err.message}`);
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

// Environment variables win over the settings file. The writes switch is off unless explicitly turned on.
export function loadConfig() {
  const file = readSettingsFile(process.env.HYPERCAFFIUM_GOOGLE_OAUTH_CONFIG || CONFIG_PATH);
  const rawWrites = process.env.GOOGLE_OAUTH_WRITES_ENABLED || file.writesEnabled;
  return {
    writesEnabled: rawWrites === true || /^(1|true|yes)$/i.test(String(rawWrites || '')),
    liveProjects: Array.isArray(file.liveProjects)
      ? file.liveProjects.filter((p) => typeof p === 'string' && PROJECT_ID.test(p))
      : [],
    gcloudPath: typeof file.gcloudPath === 'string' && file.gcloudPath ? file.gcloudPath : null,
    expectedAccount: typeof file.expectedAccount === 'string' && file.expectedAccount ? file.expectedAccount : null,
    features: resolveFeatures(file.features, 'google'),
  };
}
