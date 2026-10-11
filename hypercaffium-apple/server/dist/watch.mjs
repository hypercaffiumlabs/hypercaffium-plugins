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
var CONFIG_PATH = path2.join(os2.homedir(), ".claude-plugins", "hypercaffium-apple.json");
var LEGACY_CONFIG_PATH = path2.join(os2.homedir(), ".claude-plugins", "app-store-connect.json");
function loadConfig() {
  let file = {};
  let fileError = "";
  try {
    file = JSON.parse(fs2.readFileSync(fs2.existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") fileError = `${CONFIG_PATH} could not be read: ${err.message}`;
  }
  const rawWrites = process.env.ASC_WRITES_ENABLED || file.writesEnabled;
  return {
    keyId: process.env.ASC_KEY_ID || file.keyId || "",
    issuerId: process.env.ASC_ISSUER_ID || file.issuerId || "",
    keyPath: process.env.ASC_KEY_PATH || file.keyPath || "",
    writesEnabled: rawWrites === true || /^(1|true|yes)$/i.test(String(rawWrites || "")),
    timezone: process.env.HYPERCAFFIUM_TIMEZONE || file.timezone || "",
    fileError
  };
}
function configProblems(cfg) {
  const problems = [];
  if (cfg.fileError) problems.push(`${cfg.fileError} (in JSON files, every backslash in a path must be doubled: C:\\\\Users\\\\...)`);
  if (!cfg.keyId) problems.push("keyId is missing (the 10-character Key ID shown next to the key in App Store Connect)");
  if (!cfg.issuerId) problems.push("issuerId is missing (the UUID shown at the top of the Keys page in App Store Connect)");
  if (!cfg.keyPath) problems.push("keyPath is missing (full path to the AuthKey_XXXX.p8 file)");
  else if (!fs2.existsSync(cfg.keyPath)) problems.push(`keyPath does not exist: ${cfg.keyPath}`);
  return problems;
}
var b64url = (v) => Buffer.from(v).toString("base64url");
function makeJwt({ keyId, issuerId, keyPem, now = Math.floor(Date.now() / 1e3) }) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: issuerId, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: keyPem,
    dsaEncoding: "ieee-p1363"
    // raw r||s, which is what JWT ES256 requires
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}
var cached = { token: "", expiresAt: 0 };
function getToken() {
  const cfg = loadConfig();
  const problems = configProblems(cfg);
  if (problems.length) {
    throw new Error(
      `App Store Connect is not set up yet:
- ${problems.join("\n- ")}
Config file: ${CONFIG_PATH}`
    );
  }
  const nowMs = Date.now();
  if (cached.token && nowMs < cached.expiresAt) return cached.token;
  const keyPem = fs2.readFileSync(cfg.keyPath, "utf8");
  const token = makeJwt({ keyId: cfg.keyId, issuerId: cfg.issuerId, keyPem });
  cached = { token, expiresAt: nowMs + 10 * 60 * 1e3 };
  return token;
}

// client.js
var API_ORIGIN = "https://api.appstoreconnect.apple.com";
function assertApiUrl(url) {
  if (url.origin !== API_ORIGIN || !/^\/v[123]\//.test(url.pathname)) {
    throw new Error(`Refusing to send credentials to ${url.origin}${url.pathname}: not an App Store Connect API address.`);
  }
}
async function ascGetUrl(url) {
  assertApiUrl(url);
  const res = await fetch(url, {
    method: "GET",
    // the ONLY method this server uses in phase 2a
    headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/json" }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (body.errors || []).map((e) => `${e.status} ${e.title}: ${e.detail}`).join("; ");
    throw new Error(`Apple API ${res.status} for ${url.pathname}${detail ? ` -> ${detail}` : ""}`);
  }
  return body;
}
async function ascGet(pathname, query = {}) {
  const url = new URL(pathname, API_ORIGIN);
  for (const [k, v] of Object.entries(query)) {
    if (v !== void 0 && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return ascGetUrl(url);
}

// monitor.js
import fs3 from "node:fs";
import os3 from "node:os";
import path4 from "node:path";

// spec.js
import path3 from "node:path";
import { fileURLToPath } from "node:url";
var HERE = path3.dirname(fileURLToPath(import.meta.url));

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

// release.js
var flat = (r) => r ? { id: r.id, type: r.type, ...r.attributes || {} } : null;
var list = (body) => (body?.data || []).map(flat);
async function resolveApp(deps, appId) {
  if (appId) return appId;
  const apps = list(await deps.get("/v1/apps?limit=50"));
  if (apps.length !== 1) {
    throw new Error(`The account has ${apps.length} apps; pass appId. Options: ${apps.map((a) => `${a.name}=${a.id}`).join(", ")}`);
  }
  return apps[0].id;
}
var LIMITS = { description: 4e3, whatsNew: 4e3, keywords: 100, promotionalText: 170, marketingUrl: 255, supportUrl: 255 };
var TEXT_FIELDS = Object.keys(LIMITS);

// monitor.js
var stateDir = () => process.env.CLAUDE_PLUGINS_STATE_DIR || path4.join(os3.homedir(), ".claude-plugins", "state");
var stateFile = (name) => path4.join(stateDir(), `${name}.json`);
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
async function appleSnapshot(deps, { appId }) {
  const app = await resolveApp(deps, appId);
  const safe = async (p) => {
    try {
      return await deps.get(p);
    } catch {
      return null;
    }
  };
  const [versions, builds, subs, reviews] = await Promise.all([
    safe(`/v1/apps/${encodeURIComponent(app)}/appStoreVersions?limit=20`),
    safe(`/v1/builds?filter[app]=${encodeURIComponent(app)}&sort=-uploadedDate&limit=10`),
    safe(`/v1/apps/${encodeURIComponent(app)}/reviewSubmissions?limit=10`),
    safe(`/v1/apps/${encodeURIComponent(app)}/customerReviews?sort=-createdDate&limit=30`)
  ]);
  return {
    store: "apple",
    app,
    takenAt: (/* @__PURE__ */ new Date()).toISOString(),
    versions: versions ? Object.fromEntries(list(versions).map((v) => [`${v.platform}:${v.versionString}`, v.appStoreState || v.appVersionState])) : null,
    builds: builds ? Object.fromEntries(list(builds).map((b) => [b.version, b.processingState])) : null,
    submissions: subs ? Object.fromEntries(list(subs).map((s) => [s.id, s.state])) : null,
    reviews: reviews ? Object.fromEntries(list(reviews).map((r) => [r.id, `${r.rating}|${r.title || ""}`])) : null
  };
}
var human = (s) => String(s).replace(/_/g, " ").toLowerCase();
function diffApple(prev, cur) {
  const changes = [];
  const compare = (key, label, fmt) => {
    if (!prev[key] || !cur[key]) return;
    for (const [k, now] of Object.entries(cur[key])) {
      const was = prev[key][k];
      if (was === void 0) changes.push({ kind: `${key}:new`, message: fmt.created(k, now) });
      else if (was !== now) changes.push({ kind: `${key}:changed`, message: fmt.changed(k, was, now) });
    }
  };
  compare("versions", "version", {
    created: (k, now) => `New version ${k.split(":")[1]} appeared (${human(now)}).`,
    changed: (k, was, now) => `Version ${k.split(":")[1]}: ${human(was)} \u2192 ${human(now)}.`
  });
  compare("builds", "build", {
    created: (k, now) => `New build ${k} (${human(now)}).`,
    changed: (k, was, now) => `Build ${k}: ${human(was)} \u2192 ${human(now)}.`
  });
  compare("submissions", "submission", {
    created: (_k, now) => `A review submission was created (${human(now)}).`,
    changed: (_k, was, now) => `Review submission: ${human(was)} \u2192 ${human(now)}.`
  });
  if (prev.reviews && cur.reviews) {
    for (const [id, v] of Object.entries(cur.reviews)) {
      if (prev.reviews[id] === void 0) {
        const [rating, title] = v.split("|");
        changes.push({ kind: "review:new", message: `New App Store review: ${rating} star(s)${title ? ` "${title}"` : ""}.` });
      }
    }
  }
  return changes;
}
async function appleCheckChanges(deps, { appId, save = true }) {
  const cur = await appleSnapshot(deps, { appId });
  const name = `app-store-connect-${cur.app}`;
  const prev = loadState(name);
  const keep = (k) => cur[k] ?? prev?.[k] ?? null;
  if (save) saveState(name, { ...cur, versions: keep("versions"), builds: keep("builds"), submissions: keep("submissions"), reviews: keep("reviews") });
  if (!prev) {
    return { store: "apple", baseline: true, message: "First check: baseline saved. Changes will be reported from the next check on.", takenAtLocal: toLocalTime(cur.takenAt) };
  }
  const changes = diffApple(prev, cur);
  return {
    store: "apple",
    baseline: false,
    sinceLocal: toLocalTime(prev.takenAt),
    nowLocal: toLocalTime(cur.takenAt),
    changed: changes.length > 0,
    changes,
    message: changes.length ? `${changes.length} change(s) since the last check.` : "Nothing has changed since the last check."
  };
}

// watch.js
async function check() {
  const problems = configProblems(loadConfig());
  if (problems.length) return { error: `not set up: ${problems[0]}` };
  return appleCheckChanges({ get: (p) => ascGet(p) }, {});
}
startWatch({ store: "apple", check });
