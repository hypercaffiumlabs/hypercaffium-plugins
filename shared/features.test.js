import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describeFeatures, FEATURES, featuresFor, resolveFeatures, saveSettings } from './features.js';
import { sessionCheck } from './session-check.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'features-')), 'settings.json');

test('defaults: everything on except critical features', () => {
  const f = resolveFeatures(undefined, 'play');
  for (const x of featuresFor('play')) assert.equal(f[x.key], x.risk !== 'critical', x.key);
  assert.equal(f.refunds, false);
});

test('store-specific features only exist for their store', () => {
  assert.ok(!('refunds' in resolveFeatures({}, 'apple')), 'Apple has no refunds API');
  assert.ok(!('marketing' in resolveFeatures({}, 'play')), 'Google has no custom listing API');
  assert.ok('marketing' in resolveFeatures({}, 'apple'));
});

test('anything that is not exactly true or false falls back to the default', () => {
  const f = resolveFeatures({ uploads: 'false', users: 1, listing: false }, 'apple');
  assert.equal(f.uploads, true);
  assert.equal(f.users, false);
  assert.equal(f.listing, false);
});

test('every feature has a label and help text for each store it applies to', () => {
  for (const store of ['apple', 'play']) {
    for (const group of describeFeatures(resolveFeatures({}, store), store)) {
      for (const f of group.features) {
        assert.ok(f.label && f.help, `${store} ${f.key}`);
      }
    }
  }
  assert.equal(new Set(FEATURES.map((f) => f.key)).size, FEATURES.length);
});

test('saving keeps other settings, escapes Windows paths and never needs hand-edited JSON', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ keyId: 'ABC', custom: 1 }));
  saveSettings(file, { keyPath: 'C:\\Users\\me\\AuthKey_ABC.p8', features: { uploads: false } }, 'apple');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.keyId, 'ABC');
  assert.equal(saved.custom, 1);
  assert.equal(saved.keyPath, 'C:\\Users\\me\\AuthKey_ABC.p8');
  assert.equal(saved.features.uploads, false);
  assert.equal(saved.features.listing, true, 'all switches are written out explicitly');
});

test('saving refuses to switch a critical feature on unless the terminal menu asks', () => {
  const file = tmpFile();
  assert.throws(() => saveSettings(file, { features: { users: true } }, 'apple'), /terminal setup menu/);
  assert.ok(!fs.existsSync(file), 'nothing written');
  saveSettings(file, { features: { users: true } }, 'apple', { allowCriticalOn: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).features.users, true);
  saveSettings(file, { features: { users: false } }, 'apple'); // switching OFF is always allowed
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).features.users, false);
});

test('saving rejects unknown features, non-boolean values and a broken settings file', () => {
  const file = tmpFile();
  assert.throws(() => saveSettings(file, { features: { nope: true } }, 'apple'), /Unknown feature/);
  assert.throws(() => saveSettings(file, { features: { refunds: true } }, 'apple'), /Unknown feature/);
  assert.throws(() => saveSettings(file, { features: { listing: 'yes' } }, 'apple'), /true or false/);
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => saveSettings(file, { timezone: 'UTC' }, 'apple'), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'a broken file is left untouched');
});

test('the session check is silent once settings were chosen, and nudges otherwise', () => {
  const file = tmpFile();
  const args = { configPath: file, legacyPath: `${file}.old`, command: '/x:setup', storeName: 'X' };
  assert.match(sessionCheck(args), /not set up yet/);
  fs.writeFileSync(file, JSON.stringify({ keyId: 'A' }));
  assert.match(sessionCheck(args), /never been chosen/);
  fs.writeFileSync(file, JSON.stringify({ keyId: 'A', features: {} }));
  assert.equal(sessionCheck(args), '');
});

test('the terminal menu refuses to run without an interactive terminal', () => {
  const script = `import { runSetup } from ${JSON.stringify(new URL('./setup-cli.js', import.meta.url).href)};
    await runSetup({ store: 'apple', configPath: ${JSON.stringify(tmpFile())} });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: 's\n', encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs an interactive terminal/);
});

const GOOGLE_KEYS = ['apis', 'branding', 'clients', 'destructive', 'liveProjects', 'publishing', 'scopes', 'signIns', 'testUsers'];

test('google gets only its own features', () => {
  assert.deepEqual(Object.keys(resolveFeatures({}, 'google')).sort(), GOOGLE_KEYS);
});

test('google defaults: all on except destructive', () => {
  const f = resolveFeatures({}, 'google');
  for (const k of GOOGLE_KEYS) assert.equal(f[k], k !== 'destructive', k);
});

test('apple and play are unchanged by the google features', () => {
  const apple = featuresFor('apple').map((f) => f.key);
  const play = featuresFor('play').map((f) => f.key);
  assert.equal(apple.length, 10);
  assert.equal(play.length, 10);
  for (const k of GOOGLE_KEYS) {
    assert.ok(!apple.includes(k), `apple has ${k}`);
    assert.ok(!play.includes(k), `play has ${k}`);
  }
});

test('google features have a label and help text', () => {
  for (const group of describeFeatures(resolveFeatures({}, 'google'), 'google')) {
    for (const f of group.features) assert.ok(f.label && f.help, f.key);
  }
});

test('destructive cannot be switched on from chat', () => {
  assert.throws(() => saveSettings(tmpFile(), { features: { destructive: true } }, 'google'), /critical/);
});
