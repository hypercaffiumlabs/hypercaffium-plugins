#!/usr/bin/env node
// Scheduled Google Play watcher: shows a Windows notification only when a new review arrives. Read-only.
// Reviews only, on purpose: reading tracks needs a Play "edit", and Google keeps one open edit per app, so a
// background job could disturb work open in the console. Tracks are available on demand with play_check_changes.
// Built into dist/watch.mjs by `npm run build`.
import { startWatch } from '../../shared/watch-core.js';
import * as auth from './auth.js';
import * as client from './client.js';
import { googleCheckChanges } from './monitor.js';

async function check() {
  const cfg = auth.loadConfig();
  const problems = auth.configProblems(cfg);
  if (problems.length) return { error: `not set up: ${problems[0]}` };
  if (!cfg.defaultPackageName) return { error: 'no defaultPackageName in the config file' };
  const pkg = cfg.defaultPackageName;
  return googleCheckChanges({
    packageName: pkg,
    // No fetchTracks on purpose: no edit is ever opened by the scheduled job.
    fetchReviews: async () => (await client.playRequest('GET', `${client.APP_BASE}/${pkg}/reviews`, { maxResults: 50 })).reviews || [],
  });
}

startWatch({ store: 'google', check });
