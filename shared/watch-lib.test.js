import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearError, ERROR_TOAST_EVERY_MS, formatToast, logLine, markErrorNotified, priority, shouldNotifyError } from './watch-lib.js';

test('the most important change leads the notification, and long lists are trimmed', () => {
  const changes = [
    { message: 'Build 58 (processing).' },
    { message: 'New App Store review: 5 star(s) "Love it".' },
    { message: 'Version 1.1.4: in review → rejected.' },
    { message: 'New App Store review: 1 star(s) "Crashes".' },
    { message: 'Build 57: processing → valid.' },
  ];
  const t = formatToast('apple', changes, { max: 3 });
  assert.equal(t.title, 'App Store');
  const lines = t.body.split('\n');
  assert.match(lines[0], /rejected/);
  assert.match(lines[1], /1 star/);
  assert.equal(lines.length, 4);
  assert.match(lines[3], /and 2 more/);
});

test('priority orders problems before news before noise', () => {
  assert.ok(priority('Version 1.1.4: in review → rejected.') < priority('Build 57: processing → valid.'));
  assert.ok(priority('New Google Play review: 1 star(s) "bad"') < priority('New release on internal: 1.1.5 (completed).'));
  assert.ok(priority('New Google Play review: 5 star(s) "great"') >= 3);
});

test('errors are announced at most once per day per store, and clear when the store recovers', () => {
  const now = 1_000_000_000_000;
  let meta = {};
  assert.equal(shouldNotifyError(meta, 'apple', now), true);
  meta = markErrorNotified(meta, 'apple', now);
  assert.equal(shouldNotifyError(meta, 'apple', now + 30 * 60 * 1000), false, 'not again after 30 minutes');
  assert.equal(shouldNotifyError(meta, 'google', now + 30 * 60 * 1000), true, 'stores are independent');
  assert.equal(shouldNotifyError(meta, 'apple', now + ERROR_TOAST_EVERY_MS + 1), true, 'again after a day');
  meta = clearError(meta, 'apple');
  assert.equal(shouldNotifyError(meta, 'apple', now + 60_000), true);
});

test('log lines are one plain sentence per store', () => {
  const iso = '2026-10-11T01:00:00.000Z';
  assert.match(logLine({ store: 'apple', error: 'boom' }, iso), /ERROR boom/);
  assert.match(logLine({ store: 'apple', baseline: true }, iso), /baseline saved/);
  assert.match(logLine({ store: 'google', changed: false }, iso), /no change/);
  assert.match(logLine({ store: 'google', changed: true, changes: [{ message: 'a' }, { message: 'b' }] }, iso), /2 change\(s\): a \| b/);
});
