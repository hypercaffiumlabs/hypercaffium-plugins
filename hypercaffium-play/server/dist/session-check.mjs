import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// session-check.js
import os2 from "node:os";
import path2 from "node:path";

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

// auth.js
import os from "node:os";
import path from "node:path";
var CONFIG_PATH = path.join(os.homedir(), ".claude-plugins", "hypercaffium-play.json");
var LEGACY_CONFIG_PATH = path.join(os.homedir(), ".claude-plugins", "google-play-console.json");

// session-check.js
var msg = sessionCheck({
  configPath: CONFIG_PATH,
  legacyPath: path2.join(os2.homedir(), ".claude-plugins", "google-play-console.json"),
  command: "/hypercaffium-play:setup",
  storeName: "Google Play (hypercaffium-play)"
});
if (msg) process.stdout.write(msg);
