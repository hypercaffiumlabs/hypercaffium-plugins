import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import { loadConfig } from './config.js';

const ORIGINAL = {
  file: process.env.HYPERCAFFIUM_GOOGLE_OAUTH_CONFIG,
  writes: process.env.GOOGLE_OAUTH_WRITES_ENABLED,
};
let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcgo-config-'));
  file = path.join(dir, 'settings.json');
  process.env.HYPERCAFFIUM_GOOGLE_OAUTH_CONFIG = file;
  delete process.env.GOOGLE_OAUTH_WRITES_ENABLED;
});

afterEach(() => {
  if (ORIGINAL.file === undefined) delete process.env.HYPERCAFFIUM_GOOGLE_OAUTH_CONFIG;
  else process.env.HYPERCAFFIUM_GOOGLE_OAUTH_CONFIG = ORIGINAL.file;
  if (ORIGINAL.writes === undefined) delete process.env.GOOGLE_OAUTH_WRITES_ENABLED;
  else process.env.GOOGLE_OAUTH_WRITES_ENABLED = ORIGINAL.writes;
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

test('defaults when no file: writes off, no live projects, destructive off', () => {
  const cfg = loadConfig();
  assert.equal(cfg.writesEnabled, false);
  assert.deepEqual(cfg.liveProjects, []);
  assert.equal(cfg.features.destructive, false);
  assert.equal(cfg.gcloudPath, null);
  assert.equal(cfg.expectedAccount, null);
});

test('liveProjects keeps only valid project ids', () => {
  write({ liveProjects: ['bad id', 'hm-honey-site', 'Caps-Bad', 'my-app-2024'] });
  assert.deepEqual(loadConfig().liveProjects, ['hm-honey-site', 'my-app-2024']);
});

test('env var turns writes on', () => {
  write({ writesEnabled: false });
  process.env.GOOGLE_OAUTH_WRITES_ENABLED = 'true';
  assert.equal(loadConfig().writesEnabled, true);
});

test('writesEnabled true in the file turns writes on', () => {
  write({ writesEnabled: true });
  assert.equal(loadConfig().writesEnabled, true);
});

test('feature switches come from the file for the google store', () => {
  write({ features: { publishing: true } });
  const cfg = loadConfig();
  assert.equal(cfg.features.publishing, true);
  assert.equal(cfg.features.destructive, false);
});

test('invalid JSON throws and names the file', () => {
  write('{ not json');
  assert.throws(() => loadConfig(), (err) => err.message.includes(file));
});
