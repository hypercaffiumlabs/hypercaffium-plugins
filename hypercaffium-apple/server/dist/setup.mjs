#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// ../../shared/setup-cli.js
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ../../shared/features.js
import fs from "node:fs";
import path from "node:path";
var RISK_LEVELS = ["low", "medium", "high", "critical"];
var RISK_LABEL = {
  low: "Low risk: only testers see it, easy to undo",
  medium: "Medium risk: public, but easy to change back",
  high: "High risk: reaches real users or money",
  critical: "Critical: access, signing or customer money"
};
var FEATURES = [
  {
    key: "testing",
    risk: "low",
    label: { apple: "TestFlight", play: "Testing tracks and testers" },
    help: {
      apple: "Notes for testers, adding and removing testers, builds in groups, external beta review, expiring builds.",
      play: "Who can test your app on the internal, closed and open testing tracks."
    }
  },
  {
    key: "listing",
    risk: "medium",
    label: "Store listing",
    help: "App name, description, keywords, screenshots, preview videos, App Review details and similar listing content."
  },
  {
    key: "reviews",
    risk: "medium",
    label: "Review replies",
    help: "Public replies to customer reviews."
  },
  {
    key: "marketing",
    risk: "medium",
    label: "Marketing pages",
    stores: ["apple"],
    // Google's API has no custom store listings or listing experiments.
    help: "Custom product pages, in-app events and product page tests."
  },
  {
    key: "releases",
    risk: "high",
    label: "Releases",
    help: {
      apple: "Creating versions, attaching builds, submitting for review, phased release, releasing, availability.",
      play: "Putting versions on tracks, staged rollouts, halting, promoting, release notes."
    }
  },
  {
    key: "pricing",
    risk: "high",
    label: "Prices and offers",
    help: "Subscriptions, in-app purchases, prices, moving existing subscribers to a new price, offers and offer codes."
  },
  {
    key: "uploads",
    risk: "high",
    label: "Uploading app files",
    help: {
      apple: "Uploading a build. Skip this if EAS, Xcode or fastlane uploads your builds.",
      play: "Uploading an .aab app bundle and its crash-decoding (mapping) file. Skip this if EAS or Gradle uploads for you."
    }
  },
  {
    key: "advanced",
    risk: "high",
    label: "Everything else in the API",
    help: "Rarely used areas the dedicated tools do not cover (for example Game Center or app recovery). Still previewed and confirmed."
  },
  {
    key: "users",
    risk: "critical",
    label: "Users and permissions",
    help: "Inviting people to your developer account, changing their access, removing them."
  },
  {
    key: "signing",
    risk: "critical",
    label: "Signing keys",
    help: {
      apple: "Certificates, provisioning profiles, bundle IDs and devices. Changing these can break builds made by EAS or Xcode.",
      play: "Enrolling in and rotating the app signing key. Rotation cannot be undone."
    }
  },
  {
    key: "refunds",
    risk: "critical",
    label: "Refunds and orders",
    stores: ["play"],
    // Apple's API has no refund or order actions; Apple handles refunds itself.
    help: "Refunding orders and cancelling, revoking or deferring customer subscriptions."
  }
];
var featuresFor = (store) => FEATURES.filter((f) => !f.stores || f.stores.includes(store));
var pick = (value, store) => value && typeof value === "object" ? value[store] : value;
var isCritical = (key) => FEATURES.some((f) => f.key === key && f.risk === "critical");
var defaultOn = (key) => !isCritical(key);
function resolveFeatures(fileFeatures, store) {
  const out = {};
  for (const f of featuresFor(store)) {
    const v = fileFeatures && typeof fileFeatures === "object" ? fileFeatures[f.key] : void 0;
    out[f.key] = typeof v === "boolean" ? v : defaultOn(f.key);
  }
  return out;
}
function describeFeatures(features, store) {
  return RISK_LEVELS.map((risk) => ({
    risk,
    riskLabel: RISK_LABEL[risk],
    features: featuresFor(store).filter((f) => f.risk === risk).map((f) => ({ key: f.key, label: pick(f.label, store), on: Boolean(features[f.key]), help: pick(f.help, store) }))
  })).filter((g) => g.features.length);
}
function saveSettings(configPath, changes, store, { allowCriticalOn = false } = {}) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`${configPath} exists but is not valid JSON, so it was not changed: ${err.message}`);
  }
  const next = { ...current };
  const { features, ...rest } = changes;
  for (const [k, v] of Object.entries(rest)) {
    if (v !== void 0) next[k] = v;
  }
  if (features) {
    const known = new Set(featuresFor(store).map((f) => f.key));
    const merged = { ...resolveFeatures(current.features, store) };
    for (const [k, v] of Object.entries(features)) {
      if (!known.has(k)) throw new Error(`Unknown feature "${k}". Known: ${[...known].join(", ")}.`);
      if (typeof v !== "boolean") throw new Error(`Feature "${k}" must be true or false.`);
      if (v && isCritical(k) && !merged[k] && !allowCriticalOn) {
        throw new Error(`"${k}" is a critical feature. It can only be switched on in the terminal setup menu, not from the chat.`);
      }
      merged[k] = v;
    }
    next.features = merged;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}
`);
  fs.renameSync(tmp, configPath);
  return next;
}

// ../../shared/setup-cli.js
import fs2 from "node:fs";
var NAMES = { apple: "Hypercaffium Apple (App Store Connect)", play: "Hypercaffium Play (Google Play Console)" };
function readFile(configPath) {
  try {
    return JSON.parse(fs2.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`${configPath} is not valid JSON, so nothing was changed: ${err.message}`);
  }
}
function render(store, configPath, features, writesEnabled, dirty) {
  const lines = ["", `${NAMES[store]}: access settings`, `Settings file: ${configPath}`, ""];
  lines.push(`  w  Writes master switch: ${writesEnabled ? "ON (changes are possible, each one still previewed and confirmed)" : "OFF (read-only; previews still work)"}`);
  const numbered = [];
  for (const group of describeFeatures(features, store)) {
    lines.push("", `  ${group.riskLabel.toUpperCase()}`);
    for (const f of group.features) {
      numbered.push(f.key);
      lines.push(`  ${String(numbered.length).padStart(2)} [${f.on ? "x" : " "}] ${f.label}: ${f.help}`);
    }
  }
  lines.push("", `Type a number to switch a feature on or off, "w" for the master switch, "s" to save${dirty ? " (unsaved changes)" : ""}, or "q" to quit.`);
  return { text: lines.join("\n"), numbered };
}
async function runSetup({ store, configPath }) {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error(
      "This settings menu needs an interactive terminal.\nOpen a terminal window yourself (not through Claude) and run this same command there."
    );
    process.exitCode = 1;
    return;
  }
  const file = readFile(configPath);
  let features = resolveFeatures(file.features, store);
  let writesEnabled = file.writesEnabled === true;
  let dirty = false;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    for (; ; ) {
      const { text, numbered } = render(store, configPath, features, writesEnabled, dirty);
      console.log(text);
      const answer = (await rl.question("> ")).trim().toLowerCase();
      if (answer === "q") {
        if (dirty && (await rl.question("Quit without saving? (y/n) ")).trim().toLowerCase() !== "y") continue;
        console.log("Nothing was saved.");
        return;
      }
      if (answer === "s") {
        saveSettings(configPath, { writesEnabled, features }, store, { allowCriticalOn: true });
        console.log(`
Saved to ${configPath}.
Restart Claude Code so the plugin's tools match these settings.`);
        return;
      }
      if (answer === "w") {
        writesEnabled = !writesEnabled;
        dirty = true;
        continue;
      }
      const n = Number(answer);
      if (!Number.isInteger(n) || n < 1 || n > numbered.length) {
        console.log("Please type one of the numbers shown, w, s or q.");
        continue;
      }
      const key = numbered[n - 1];
      if (!features[key] && isCritical(key)) {
        const f = featuresFor(store).find((x) => x.key === key);
        console.log(`
"${pick(f.label, store)}" is a CRITICAL feature: ${pick(f.help, store)}`);
        console.log("Every change in it is still previewed and needs your yes, through a separate approval tool.");
        if ((await rl.question("Type YES (in capitals) to switch it on: ")).trim() !== "YES") {
          console.log("Left off.");
          continue;
        }
      }
      features = { ...features, [key]: !features[key] };
      dirty = true;
    }
  } finally {
    rl.close();
  }
}

// auth.js
import os from "node:os";
import path2 from "node:path";
var CONFIG_PATH = path2.join(os.homedir(), ".claude-plugins", "hypercaffium-apple.json");
var LEGACY_CONFIG_PATH = path2.join(os.homedir(), ".claude-plugins", "app-store-connect.json");

// setup.js
await runSetup({ store: "apple", configPath: CONFIG_PATH });
