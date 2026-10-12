// SessionStart hook entry (built into dist/session-check.mjs). See shared/session-check.js.
import os from 'node:os';
import path from 'node:path';
import { sessionCheck } from '../../shared/session-check.js';
import { CONFIG_PATH } from './auth.js';

const msg = sessionCheck({
  configPath: CONFIG_PATH,
  legacyPath: path.join(os.homedir(), '.claude-plugins', 'app-store-connect.json'),
  command: '/hypercaffium-apple:setup',
  storeName: 'App Store Connect (hypercaffium-apple)',
});
if (msg) process.stdout.write(msg);
