#!/usr/bin/env node
// Scheduled App Store watcher: checks versions, builds, review submissions and new reviews, and shows a
// Windows notification only when something changed. Read-only. Built into dist/watch.mjs by `npm run build`.
import { startWatch } from '../../shared/watch-core.js';
import * as auth from './auth.js';
import { ascGet } from './client.js';
import { appleCheckChanges } from './monitor.js';

async function check() {
  const problems = auth.configProblems(auth.loadConfig());
  if (problems.length) return { error: `not set up: ${problems[0]}` };
  return appleCheckChanges({ get: (p) => ascGet(p) }, {});
}

startWatch({ store: 'apple', check });
