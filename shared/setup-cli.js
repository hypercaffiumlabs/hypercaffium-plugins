// The terminal setup menu. It needs a real keyboard (an interactive terminal), so it is the one place
// where critical features can be switched on: Claude's commands run without one and cannot drive it.
// Each store plugin bundles this into server/dist/setup.mjs.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { describeFeatures, featuresFor, isCritical, pick, resolveFeatures, saveSettings } from './features.js';
import fs from 'node:fs';

const NAMES = { apple: 'Hypercaffium Apple (App Store Connect)', play: 'Hypercaffium Play (Google Play Console)', google: 'Hypercaffium Google OAuth (Google Auth Platform)' };

function readFile(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`${configPath} is not valid JSON, so nothing was changed: ${err.message}`);
  }
}

function render(store, configPath, features, writesEnabled, dirty) {
  const lines = ['', `${NAMES[store]}: access settings`, `Settings file: ${configPath}`, ''];
  lines.push(`  w  Writes master switch: ${writesEnabled ? 'ON (changes are possible, each one still previewed and confirmed)' : 'OFF (read-only; previews still work)'}`);
  const numbered = [];
  for (const group of describeFeatures(features, store)) {
    lines.push('', `  ${group.riskLabel.toUpperCase()}`);
    for (const f of group.features) {
      numbered.push(f.key);
      lines.push(`  ${String(numbered.length).padStart(2)} [${f.on ? 'x' : ' '}] ${f.label}: ${f.help}`);
    }
  }
  lines.push('', `Type a number to switch a feature on or off, "w" for the master switch, "s" to save${dirty ? ' (unsaved changes)' : ''}, or "q" to quit.`);
  return { text: lines.join('\n'), numbered };
}

export async function runSetup({ store, configPath }) {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error(
      'This settings menu needs an interactive terminal.\nOpen a terminal window yourself (not through Claude) and run this same command there.',
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
    for (;;) {
      const { text, numbered } = render(store, configPath, features, writesEnabled, dirty);
      console.log(text);
      const answer = (await rl.question('> ')).trim().toLowerCase();
      if (answer === 'q') {
        if (dirty && (await rl.question('Quit without saving? (y/n) ')).trim().toLowerCase() !== 'y') continue;
        console.log('Nothing was saved.');
        return;
      }
      if (answer === 's') {
        saveSettings(configPath, { writesEnabled, features }, store, { allowCriticalOn: true });
        console.log(`\nSaved to ${configPath}.\nRestart Claude Code so the plugin's tools match these settings.`);
        return;
      }
      if (answer === 'w') {
        writesEnabled = !writesEnabled;
        dirty = true;
        continue;
      }
      const n = Number(answer);
      if (!Number.isInteger(n) || n < 1 || n > numbered.length) {
        console.log('Please type one of the numbers shown, w, s or q.');
        continue;
      }
      const key = numbered[n - 1];
      if (!features[key] && isCritical(key)) {
        const f = featuresFor(store).find((x) => x.key === key);
        console.log(`\n"${pick(f.label, store)}" is a CRITICAL feature: ${pick(f.help, store)}`);
        console.log('Every change in it is still previewed and needs your yes, through a separate approval tool.');
        if ((await rl.question('Type YES (in capitals) to switch it on: ')).trim() !== 'YES') {
          console.log('Left off.');
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
