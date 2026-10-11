// Shared engine for the per-store scheduled watchers (hypercaffium-apple and hypercaffium-play each
// bundle a copy of this file into their own server/dist/watch.mjs, so every published plugin stands alone).
// It checks ONE store, shows a Windows notification only when something changed, and announces a
// persistent problem at most once a day. Every request the store check makes is a read.
//
//   node watch.mjs               check the store, notify on changes
//   node watch.mjs --no-toast    same, but never show notifications
//   node watch.mjs --test-toast  just show a test notification
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearError, formatToast, logLine, markErrorNotified, shouldNotifyError, STORE_TITLE } from './watch-lib.js';

export function windowsToast(title, body) {
  // Text goes through environment variables, never into the command string.
  const script = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
    $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $n = $t.GetElementsByTagName('text')
    $n.Item(0).AppendChild($t.CreateTextNode($env:TOAST_TITLE)) | Out-Null
    $n.Item(1).AppendChild($t.CreateTextNode($env:TOAST_BODY)) | Out-Null
    $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
  `;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      env: { ...process.env, TOAST_TITLE: title, TOAST_BODY: body },
      stdio: 'ignore',
      windowsHide: true,
    });
    p.on('error', () => resolve());
    p.on('exit', () => resolve());
  });
}

// Each store keeps its own log and state files, so two watchers running at the same moment never
// overwrite each other.
export function watchPaths(store, baseDir = path.join(os.homedir(), '.claude-plugins')) {
  return {
    baseDir,
    logFile: path.join(baseDir, `watch-${store}.log`),
    metaFile: path.join(baseDir, 'state', `watch-${store}-meta.json`),
    latestFile: path.join(baseDir, 'state', `watch-${store}-latest.json`),
  };
}

function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`);
    // Keep the log small: trim to the last ~500 lines once it grows.
    if (fs.statSync(logFile).size > 200_000) {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n');
      fs.writeFileSync(logFile, lines.slice(-500).join('\n'));
    }
  } catch {
    // logging must never break the watcher
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 1));
  } catch {
    // ignore
  }
}

// store: 'apple' | 'google'. check: async () => { changed, changes, baseline } or { error }.
export async function runWatch({ store, check, args = process.argv.slice(2), toast = windowsToast, baseDir, now = Date.now }) {
  const flags = new Set(args);
  const notify = flags.has('--no-toast') ? async () => {} : toast;
  const files = watchPaths(store, baseDir);
  const label = STORE_TITLE[store] || store;

  if (flags.has('--test-toast')) {
    await notify(`${label} watch`, 'Notifications are working. You will only hear from me when something changes.');
    return;
  }

  let result;
  try {
    result = await check();
  } catch (err) {
    result = { error: String(err.message || err).slice(0, 300) };
  }
  result = { ...result, store };

  let meta = readJson(files.metaFile);
  appendLog(files.logFile, logLine(result, new Date(now()).toISOString()));
  if (result.error) {
    if (shouldNotifyError(meta, store, now())) {
      await notify(`${label} watch`, `Cannot check right now: ${result.error}`);
      meta = markErrorNotified(meta, store, now());
    }
  } else {
    meta = clearError(meta, store);
    if (result.changed) {
      const t = formatToast(store, result.changes);
      await notify(t.title, t.body);
    }
  }
  writeJson(files.metaFile, meta);
  // Latest result for anything (including Claude) that wants to read it.
  writeJson(files.latestFile, { at: new Date(now()).toISOString(), result });
}

// Entry point for a plugin's watch.js: never lets a scheduled task look "failed" for a transient problem.
export function startWatch(options) {
  return runWatch(options).catch((err) => {
    appendLog(watchPaths(options.store).logFile, `${new Date().toISOString()} watcher crashed: ${String(err.message || err)}`);
    process.exitCode = 0;
  });
}
