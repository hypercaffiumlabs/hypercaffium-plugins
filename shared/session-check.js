// SessionStart hook: if a store plugin is installed but its settings were never chosen, tell Claude
// so it can point the owner at the setup command. Prints nothing once settings exist, so it costs
// nothing in normal sessions. Each plugin bundles this into server/dist/session-check.mjs.
import fs from 'node:fs';

export function sessionCheck({ configPath, legacyPath, command, storeName }) {
  let file = null;
  for (const p of [configPath, legacyPath]) {
    try {
      file = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    } catch {
      // missing or unreadable: try the next one
    }
  }
  if (file && file.features) return '';
  return file
    ? `${storeName} plugin: its access settings have never been chosen, so defaults apply. Tell the owner once, briefly, that they can review them with ${command}.`
    : `${storeName} plugin is installed but not set up yet. Tell the owner once, briefly, that ${command} connects their account and chooses what the plugin may change.`;
}
