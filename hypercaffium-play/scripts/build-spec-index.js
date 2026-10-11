#!/usr/bin/env node
// Builds server/spec/play-methods.json (compact method index) and COVERAGE.md
// from Google's official Play Developer API discovery document.
//
//   node scripts/build-spec-index.js                 download the newest description from Google, then build
//   node scripts/build-spec-index.js --from <file>   build from an already-downloaded discovery JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DISCOVERY_URL = 'https://androidpublisher.googleapis.com/$discovery/rest?version=v3';

async function obtain() {
  const i = process.argv.indexOf('--from');
  if (i > 0) return JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  const res = await fetch(DISCOVERY_URL);
  if (!res.ok) throw new Error(`Could not download Google's API description: HTTP ${res.status}`);
  return res.json();
}

const doc = await obtain();
const methods = [];
(function walk(node) {
  for (const m of Object.values(node.methods || {})) {
    // {+name} means "reserved expansion": the value may itself contain slashes (e.g. developers/123).
    const reserved = new Set([...m.path.matchAll(/\{\+([^}]+)\}/g)].map((x) => x[1]));
    const params = Object.entries(m.parameters || {}).map(([name, p]) => {
      const out = { name, in: p.location };
      if (p.required) out.required = true;
      if (reserved.has(name)) out.reserved = true;
      if (p.type) out.type = p.type;
      if (Array.isArray(p.enum) && p.enum.length <= 40) out.enum = p.enum;
      return out;
    });
    methods.push({
      id: m.id.replace(/^androidpublisher\./, ''),
      method: m.httpMethod,
      path: `/${m.path.replace(/\{\+/g, '{')}`,
      params,
      hasBody: Boolean(m.request) || undefined,
      mediaUpload: Boolean(m.supportsMediaUpload) || undefined,
      deprecated: /deprecat/i.test(m.description || '') || undefined,
    });
  }
  for (const r of Object.values(node.resources || {})) walk(r);
})(doc);
methods.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const outDir = path.join(ROOT, 'server', 'spec');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'play-methods.json'),
  JSON.stringify({ specRevision: doc.revision, generated: new Date().toISOString(), methods }),
);

const has = (id) => methods.some((m) => m.id === id);
const hasRe = (re, method) => methods.some((m) => re.test(m.id) && (!method || m.method === method));
const checks = [
  ['Create a brand-new app', hasRe(/^applications\.(create|insert)$/)],
  ['Upload an app bundle (.aab)', has('edits.bundles.upload')],
  ['Set a track release and staged rollout', has('edits.tracks.update')],
  ['Commit an edit (publish changes)', has('edits.commit')],
  ['Edit store listing text', has('edits.listings.update')],
  ['Upload screenshots and images', has('edits.images.upload')],
  ['Reply to user reviews', has('reviews.reply')],
  ['Manage testers', has('edits.testers.update')],
  ['Subscriptions and in-app products', hasRe(/^(monetization\.subscriptions|inappproducts)\./)],
  ['Orders and refunds', hasRe(/^orders\./)],
  ['Invite and manage users', has('users.create')],
  ['Per-app permission grants', has('grants.create')],
  ['Data safety declaration', hasRe(/datasafety/i)],
  ['Content rating questionnaire', hasRe(/contentrating/i)],
];

const byRes = new Map();
for (const m of methods) {
  const top = m.id.split('.')[0];
  const c = byRes.get(top) || { GET: 0, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 };
  c[m.method] = (c[m.method] || 0) + 1;
  byRes.set(top, c);
}
const totals = methods.reduce((a, m) => ((a[m.method] = (a[m.method] || 0) + 1), a), {});

let md = `# Google Play Developer API coverage\n\nGenerated from Google's official discovery document, revision **${doc.revision}**, on ${new Date().toISOString().slice(0, 10)}.\n\n`;
md += `**${methods.length} methods**: ${totals.GET || 0} reads (GET), ${totals.POST || 0} POST, ${totals.PUT || 0} PUT, ${totals.PATCH || 0} PATCH, ${totals.DELETE || 0} DELETE.\n\n`;
md += `## Notable capabilities (present in Google's API?)\n\n| Capability | In Google's API |\n|---|---|\n`;
for (const [name, ok] of checks) md += `| ${name} | ${ok ? 'yes' : '**no (console only)**'} |\n`;
md += `\n"No" means the method is not in Google's published description, so it cannot be done through any API client.\n\n## Methods by area\n\n| Area | GET | POST | PUT | PATCH | DELETE |\n|---|---|---|---|---|---|\n`;
for (const [t, c] of [...byRes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  md += `| ${t} | ${c.GET} | ${c.POST} | ${c.PUT} | ${c.PATCH} | ${c.DELETE} |\n`;
}
fs.writeFileSync(path.join(ROOT, 'COVERAGE.md'), md);

console.log(`Indexed ${methods.length} methods, revision ${doc.revision}`);
for (const [name, ok] of checks) console.log(`${ok ? 'yes' : 'NO '}  ${name}`);
