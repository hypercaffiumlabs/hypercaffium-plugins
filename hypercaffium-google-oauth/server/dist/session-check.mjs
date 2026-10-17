import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// ../../shared/session-check.js
import fs from "node:fs";
function sessionCheck({ configPath, legacyPath, command, storeName }) {
  let file = null;
  for (const p of [configPath, legacyPath]) {
    try {
      file = JSON.parse(fs.readFileSync(p, "utf8"));
      break;
    } catch {
    }
  }
  if (file && file.features) return "";
  return file ? `${storeName} plugin: its access settings have never been chosen, so defaults apply. Tell the owner once, briefly, that they can review them with ${command}.` : `${storeName} plugin is installed but not set up yet. Tell the owner once, briefly, that ${command} connects their account and chooses what the plugin may change.`;
}

// config.js
import os from "node:os";
import path from "node:path";
var PLUGIN = "hypercaffium-google-oauth";
var CONFIG_PATH = path.join(os.homedir(), ".claude-plugins", `${PLUGIN}.json`);
var RECIPES_DIR = path.join(os.homedir(), ".claude-plugins", PLUGIN, "recipes");

// session-check.js
var msg = sessionCheck({
  configPath: CONFIG_PATH,
  command: "/hypercaffium-google-oauth:setup",
  storeName: "Hypercaffium Google OAuth"
});
if (msg) process.stdout.write(msg);
