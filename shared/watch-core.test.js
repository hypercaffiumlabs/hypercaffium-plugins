import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWatch, watchPaths } from './watch-core.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watch-core-'));
const recorder = () => {
  const toasts = [];
  return { toasts, toast: async (title, body) => toasts.push({ title, body }) };
};

test('a watcher only writes its own store files', async () => {
  const baseDir = tmp();
  const r = recorder();
  await runWatch({ store: 'apple', check: async () => ({ changed: false }), args: [], toast: r.toast, baseDir });
  const p = watchPaths('apple', baseDir);
  assert.ok(fs.existsSync(p.logFile));
  assert.ok(fs.existsSync(p.metaFile));
  assert.ok(fs.existsSync(p.latestFile));
  const all = [...fs.readdirSync(baseDir), ...fs.readdirSync(path.join(baseDir, 'state'))];
  assert.ok(all.every((f) => !/google/.test(f)), `no Google files: ${all.join(', ')}`);
  assert.equal(r.toasts.length, 0, 'no change means no notification');
});

test('changes produce one notification titled with the store', async () => {
  const baseDir = tmp();
  const r = recorder();
  const changes = [{ message: 'New Google Play review: 1 star(s) "bad"' }];
  await runWatch({ store: 'google', check: async () => ({ changed: true, changes }), args: [], toast: r.toast, baseDir });
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].title, 'Google Play');
  assert.match(r.toasts[0].body, /1 star/);
});

test('a persistent problem is announced once a day, and a thrown error counts as a problem', async () => {
  const baseDir = tmp();
  const r = recorder();
  let t = 1_000_000_000_000;
  const now = () => t;
  const check = async () => {
    throw new Error('network down');
  };
  await runWatch({ store: 'apple', check, args: [], toast: r.toast, baseDir, now });
  t += 30 * 60 * 1000;
  await runWatch({ store: 'apple', check, args: [], toast: r.toast, baseDir, now });
  assert.equal(r.toasts.length, 1, 'not again after 30 minutes');
  assert.match(r.toasts[0].body, /network down/);
  t += 24 * 60 * 60 * 1000;
  await runWatch({ store: 'apple', check, args: [], toast: r.toast, baseDir, now });
  assert.equal(r.toasts.length, 2, 'again after a day');
});

test('--no-toast stays silent and --test-toast only notifies', async () => {
  const baseDir = tmp();
  const r = recorder();
  const changes = [{ message: 'Build 57: processing → valid.' }];
  await runWatch({ store: 'apple', check: async () => ({ changed: true, changes }), args: ['--no-toast'], toast: r.toast, baseDir });
  assert.equal(r.toasts.length, 0);
  let called = false;
  await runWatch({ store: 'apple', check: async () => { called = true; return {}; }, args: ['--test-toast'], toast: r.toast, baseDir });
  assert.equal(called, false, 'test toast does not touch the store');
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].title, 'App Store watch');
});
