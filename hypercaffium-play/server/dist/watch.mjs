#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// ../../shared/watch-core.js
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ../../shared/watch-lib.js
var ERROR_TOAST_EVERY_MS = 24 * 60 * 60 * 1e3;
var STORE_TITLE = { apple: "App Store", google: "Google Play" };
function priority(message) {
  const m = message.toLowerCase();
  if (/reject|unresolved|invalid|failed|halted/.test(m)) return 0;
  if (/ star\(s\)/.test(m) && /\b[12] star/.test(m)) return 1;
  if (/→|new version|new release|new build/.test(m)) return 2;
  return 3;
}
function formatToast(store, changes, { max = 3 } = {}) {
  const sorted = [...changes].sort((a, b) => priority(a.message) - priority(b.message));
  const lines = sorted.slice(0, max).map((c) => c.message);
  if (sorted.length > max) lines.push(`...and ${sorted.length - max} more.`);
  return { title: `${STORE_TITLE[store] || store}`, body: lines.join("\n") };
}
function shouldNotifyError(meta, store, now = Date.now()) {
  const last = meta?.errorToastAt?.[store];
  return !last || now - last >= ERROR_TOAST_EVERY_MS;
}
function markErrorNotified(meta, store, now = Date.now()) {
  return { ...meta, errorToastAt: { ...meta?.errorToastAt || {}, [store]: now } };
}
function clearError(meta, store) {
  const next = { ...meta?.errorToastAt || {} };
  delete next[store];
  return { ...meta, errorToastAt: next };
}
function logLine(result, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
  if (result.error) return `${nowIso} ${result.store}: ERROR ${result.error}`;
  if (result.baseline) return `${nowIso} ${result.store}: baseline saved`;
  if (!result.changed) return `${nowIso} ${result.store}: no change`;
  return `${nowIso} ${result.store}: ${result.changes.length} change(s): ${result.changes.map((c) => c.message).join(" | ")}`;
}

// ../../shared/watch-core.js
function windowsToast(title, body) {
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
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
      env: { ...process.env, TOAST_TITLE: title, TOAST_BODY: body },
      stdio: "ignore",
      windowsHide: true
    });
    p.on("error", () => resolve());
    p.on("exit", () => resolve());
  });
}
function watchPaths(store, baseDir = path.join(os.homedir(), ".claude-plugins")) {
  return {
    baseDir,
    logFile: path.join(baseDir, `watch-${store}.log`),
    metaFile: path.join(baseDir, "state", `watch-${store}-meta.json`),
    latestFile: path.join(baseDir, "state", `watch-${store}-latest.json`)
  };
}
function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}
`);
    if (fs.statSync(logFile).size > 2e5) {
      const lines = fs.readFileSync(logFile, "utf8").split("\n");
      fs.writeFileSync(logFile, lines.slice(-500).join("\n"));
    }
  } catch {
  }
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 1));
  } catch {
  }
}
async function runWatch({ store, check: check2, args = process.argv.slice(2), toast = windowsToast, baseDir, now = Date.now }) {
  const flags = new Set(args);
  const notify = flags.has("--no-toast") ? async () => {
  } : toast;
  const files = watchPaths(store, baseDir);
  const label = STORE_TITLE[store] || store;
  if (flags.has("--test-toast")) {
    await notify(`${label} watch`, "Notifications are working. You will only hear from me when something changes.");
    return;
  }
  let result;
  try {
    result = await check2();
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
  writeJson(files.latestFile, { at: new Date(now()).toISOString(), result });
}
function startWatch(options) {
  return runWatch(options).catch((err) => {
    appendLog(watchPaths(options.store).logFile, `${(/* @__PURE__ */ new Date()).toISOString()} watcher crashed: ${String(err.message || err)}`);
    process.exitCode = 0;
  });
}

// auth.js
import crypto from "node:crypto";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
var CONFIG_PATH = path2.join(os2.homedir(), ".claude-plugins", "hypercaffium-play.json");
var LEGACY_CONFIG_PATH = path2.join(os2.homedir(), ".claude-plugins", "google-play-console.json");
var SCOPE = "https://www.googleapis.com/auth/androidpublisher";
function loadConfig() {
  let file = {};
  let fileError = "";
  try {
    file = JSON.parse(fs2.readFileSync(fs2.existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") fileError = `${CONFIG_PATH} could not be read: ${err.message}`;
  }
  const rawWrites = process.env.PLAY_WRITES_ENABLED || file.writesEnabled;
  return {
    serviceAccountKeyPath: process.env.PLAY_SA_KEY_PATH || file.serviceAccountKeyPath || "",
    defaultPackageName: process.env.PLAY_PACKAGE_NAME || file.defaultPackageName || "",
    writesEnabled: rawWrites === true || /^(1|true|yes)$/i.test(String(rawWrites || "")),
    timezone: process.env.HYPERCAFFIUM_TIMEZONE || file.timezone || "",
    fileError
  };
}
function configProblems(cfg) {
  const problems = [];
  if (cfg.fileError) problems.push(`${cfg.fileError} (in JSON files, every backslash in a path must be doubled: C:\\\\Users\\\\...)`);
  if (!cfg.serviceAccountKeyPath) problems.push("serviceAccountKeyPath is missing (full path to the service-account .json key file)");
  else if (!fs2.existsSync(cfg.serviceAccountKeyPath)) problems.push(`serviceAccountKeyPath does not exist: ${cfg.serviceAccountKeyPath}`);
  return problems;
}
var b64url = (v) => Buffer.from(v).toString("base64url");
function makeAssertion({ clientEmail, privateKeyPem, tokenUri, now = Math.floor(Date.now() / 1e3) }) {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: clientEmail, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(input), privateKeyPem);
  return `${input}.${sig.toString("base64url")}`;
}
var cached = { token: "", expiresAt: 0 };
async function getAccessToken() {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) {
    throw new Error(`Google Play is not set up yet:
- ${problems.join("\n- ")}
Config file: ${CONFIG_PATH}`);
  }
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  const sa = JSON.parse(fs2.readFileSync(cfg.serviceAccountKeyPath, "utf8"));
  const tokenUri = /^https:\/\/oauth2\.googleapis\.com\//.test(sa.token_uri || "") ? sa.token_uri : "https://oauth2.googleapis.com/token";
  const assertion = makeAssertion({ clientEmail: sa.client_email, privateKeyPem: sa.private_key, tokenUri });
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token request failed (${res.status}): ${body.error_description || body.error || "unknown error"}`);
  }
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 120) * 1e3 };
  return cached.token;
}

// guard.js
var V3 = "/androidpublisher/v3/";
var SAFE_PATH = /^\/androidpublisher\/v3\/[A-Za-z0-9_\-/:.%~]+$/;
var PKG = "[A-Za-z0-9._]+";
var EDIT_ID = "[A-Za-z0-9_\\-]+";
var CREATE_EDIT = new RegExp(`^${V3}applications/${PKG}/edits$`);
var DELETE_EDIT = new RegExp(`^${V3}applications/${PKG}/edits/${EDIT_ID}$`);
var ACTION_SUFFIX = /:(commit|validate|upload|publish)$/i;
var APP_PATH = new RegExp(`^${V3}applications/${PKG}/[A-Za-z0-9_\\-/:.%~]+$`);
var COMMIT = new RegExp(`^${V3}applications/${PKG}/edits/${EDIT_ID}:commit$`);
var UPLOAD_IMAGE = new RegExp(
  `^/upload${V3}applications/${PKG}/edits/${EDIT_ID}/listings/[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*/(icon|featureGraphic|phoneScreenshots|sevenInchScreenshots|tenInchScreenshots|tvBanner|tvScreenshots|wearScreenshots)$`
);
function assertAllowed(method, pathname) {
  if (pathname.split("/").some((seg) => seg === "." || seg === ".." || seg.toLowerCase() === "%2e" || seg.toLowerCase() === "%2e%2e")) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} contains a dot-segment.`);
  }
  let allowed = false;
  if (method === "GET") allowed = SAFE_PATH.test(pathname) && !ACTION_SUFFIX.test(pathname);
  else if (method === "POST") allowed = CREATE_EDIT.test(pathname);
  else if (method === "DELETE") allowed = DELETE_EDIT.test(pathname);
  if (!allowed) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} is not a read-only request.`);
  }
}

// client.js
var API_ORIGIN = "https://androidpublisher.googleapis.com";
var APP_BASE = "/androidpublisher/v3/applications";
async function playRequest(method, pathname, query = {}) {
  assertAllowed(method, pathname);
  const url = new URL(pathname, API_ORIGIN);
  for (const [k, v] of Object.entries(query)) {
    if (v !== void 0 && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers = { Authorization: `Bearer ${await getAccessToken()}`, Accept: "application/json" };
  const init = { method, headers };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = "{}";
  }
  const res = await fetch(url, init);
  if (method === "DELETE" && res.status === 204) return {};
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error || {};
    throw new Error(`Google Play API ${res.status} for ${url.pathname}: ${e.message || e.status || "unknown error"}`);
  }
  return body;
}

// monitor.js
import fs3 from "node:fs";
import os3 from "node:os";
import path3 from "node:path";

// util.js
function getTimezone() {
  const wanted = process.env.HYPERCAFFIUM_TIMEZONE;
  if (wanted) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: wanted });
      return wanted;
    } catch {
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
function toLocalTime(value) {
  if (!value) return value;
  const d = new Date(typeof value === "object" && value.seconds ? Number(value.seconds) * 1e3 : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-US", {
    timeZone: getTimezone(),
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

// monitor.js
var stateDir = () => process.env.CLAUDE_PLUGINS_STATE_DIR || path3.join(os3.homedir(), ".claude-plugins", "state");
var stateFile = (name) => path3.join(stateDir(), `${name}.json`);
function loadState(name) {
  try {
    return JSON.parse(fs3.readFileSync(stateFile(name), "utf8"));
  } catch {
    return null;
  }
}
function saveState(name, value) {
  fs3.mkdirSync(stateDir(), { recursive: true });
  fs3.writeFileSync(stateFile(name), JSON.stringify(value, null, 1));
}
var pct = (r) => r.status === "completed" ? 100 : r.userFraction !== void 0 ? Math.round(Number(r.userFraction) * 1e4) / 100 : null;
function snapshotFromGoogle({ packageName, tracks, reviews }) {
  const releases = {};
  for (const t of tracks || []) {
    for (const r of t.releases || []) {
      const key = `${t.track}:${r.name || (r.versionCodes || []).join("+")}`;
      releases[key] = `${r.status}|${pct(r) ?? ""}|${(r.versionCodes || []).join(",")}`;
    }
  }
  const reviewMap = {};
  for (const r of reviews || []) {
    const u = r.comments?.find((c) => c.userComment)?.userComment || {};
    reviewMap[r.reviewId] = `${u.starRating ?? "?"}|${(u.text || "").replace(/\s+/g, " ").slice(0, 80)}`;
  }
  return { store: "google", package: packageName, takenAt: (/* @__PURE__ */ new Date()).toISOString(), releases: tracks ? releases : null, reviews: reviews ? reviewMap : null };
}
var describe = (v) => {
  const [status, percent] = v.split("|");
  return percent ? `${status} at ${percent}%` : status;
};
function diffGoogle(prev, cur) {
  const changes = [];
  if (prev.releases && cur.releases) {
    for (const [k, now] of Object.entries(cur.releases)) {
      const [track, name] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
      const was = prev.releases[k];
      if (was === void 0) changes.push({ kind: "release:new", message: `New release on ${track}: ${name} (${describe(now)}).` });
      else if (was !== now) changes.push({ kind: "release:changed", message: `${track} ${name}: ${describe(was)} \u2192 ${describe(now)}.` });
    }
  }
  if (prev.reviews && cur.reviews) {
    for (const [id, v] of Object.entries(cur.reviews)) {
      if (prev.reviews[id] === void 0) {
        const [stars, text] = v.split("|");
        changes.push({ kind: "review:new", message: `New Google Play review: ${stars} star(s)${text ? ` "${text}"` : ""}.` });
      }
    }
  }
  return changes;
}
async function googleCheckChanges({ packageName, fetchTracks, fetchReviews, save = true }) {
  const safe = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  const [tracks, reviews] = await Promise.all([safe(fetchTracks), safe(fetchReviews)]);
  const cur = snapshotFromGoogle({ packageName, tracks, reviews });
  const name = `google-play-console-${packageName}`;
  const prev = loadState(name);
  const toSave = { ...cur, releases: cur.releases ?? prev?.releases ?? null, reviews: cur.reviews ?? prev?.reviews ?? null };
  if (save) saveState(name, toSave);
  if (!prev) {
    return { store: "google", baseline: true, message: "First check: baseline saved. Changes will be reported from the next check on.", takenAtLocal: toLocalTime(cur.takenAt) };
  }
  const changes = diffGoogle(prev, cur);
  return {
    store: "google",
    baseline: false,
    sinceLocal: toLocalTime(prev.takenAt),
    nowLocal: toLocalTime(cur.takenAt),
    changed: changes.length > 0,
    changes,
    note: "Google only returns reviews from roughly the last week.",
    message: changes.length ? `${changes.length} change(s) since the last check.` : "Nothing has changed since the last check."
  };
}

// watch.js
async function check() {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) return { error: `not set up: ${problems[0]}` };
  if (!cfg.defaultPackageName) return { error: "no defaultPackageName in the config file" };
  const pkg = cfg.defaultPackageName;
  return googleCheckChanges({
    packageName: pkg,
    // No fetchTracks on purpose: no edit is ever opened by the scheduled job.
    fetchReviews: async () => (await playRequest("GET", `${APP_BASE}/${pkg}/reviews`, { maxResults: 50 })).reviews || []
  });
}
startWatch({ store: "google", check });
