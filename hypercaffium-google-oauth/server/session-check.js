// SessionStart hook entry (built into dist/session-check.mjs). See shared/session-check.js.
import { sessionCheck } from '../../shared/session-check.js';
import { CONFIG_PATH } from './config.js';

const msg = sessionCheck({
  configPath: CONFIG_PATH,
  command: '/hypercaffium-google-oauth:setup',
  storeName: 'Hypercaffium Google OAuth',
});
if (msg) process.stdout.write(msg);
