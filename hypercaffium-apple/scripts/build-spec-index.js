#!/usr/bin/env node
// Builds server/spec/asc-operations.json (compact operation index) and COVERAGE.md
// from Apple's official App Store Connect OpenAPI spec.
//
//   node scripts/build-spec-index.js                 download the newest spec from Apple, then build
//   node scripts/build-spec-index.js --from <file>   build from an already-extracted openapi.oas.json
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SPEC_URL = 'https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip';

async function obtainSpec() {
  const i = process.argv.indexOf('--from');
  if (i > 0) return process.argv[i + 1];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-spec-'));
  const zip = path.join(dir, 'spec.zip');
  const res = await fetch(SPEC_URL);
  if (!res.ok) throw new Error(`Could not download Apple's spec: HTTP ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const out = path.join(dir, 'x');
  fs.mkdirSync(out);
  execFileSync('tar', ['-xf', zip, '-C', out]); // bsdtar ships with Windows 10+, macOS and Linux
  const found = fs.readdirSync(out).find((f) => f === 'openapi.oas.json');
  if (!found) throw new Error('openapi.oas.json not found in the downloaded zip');
  return path.join(out, found);
}

function compactParam(p) {
  const s = p.schema || {};
  const item = s.type === 'array' ? s.items || {} : s;
  const out = { name: p.name, in: p.in };
  if (p.required) out.required = true;
  if (s.type) out.type = s.type === 'array' ? `array<${item.type || 'string'}>` : s.type;
  if (Array.isArray(item.enum) && item.enum.length <= 40) out.enum = item.enum;
  if (p.deprecated) out.deprecated = true;
  return out;
}

const specPath = await obtainSpec();
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

// ---- request-body shapes ---------------------------------------------------
const deref = (s) => {
  let cur = s;
  for (let i = 0; i < 8 && cur && cur.$ref; i++) cur = spec.components.schemas[cur.$ref.split('/').pop()];
  return cur || {};
};

// Compact description of one attribute: "string", "boolean", "date", or "A|B|C" for enums.
function attrType(raw) {
  const s = deref(raw);
  if (Array.isArray(s.enum)) return s.enum.length <= 40 ? s.enum.join('|') : `enum(${s.enum.length} values)`;
  if (s.type === 'array') return `array<${attrType(s.items || {})}>`;
  if (s.format) return s.format;
  return s.type || 'object';
}

function bodyShape(requestBody) {
  const json = requestBody?.content?.['application/json']?.schema;
  if (!json) return undefined;
  const root = deref(json);
  const data = deref(root.properties?.data || {});
  const shape = {};
  const typeEnum = deref(data.properties?.type || {}).enum;
  if (typeEnum) shape.type = typeEnum[0];
  const attrs = deref(data.properties?.attributes || {});
  if (attrs.properties) {
    shape.attributes = Object.fromEntries(Object.entries(attrs.properties).map(([k, v]) => [k, attrType(v)]));
    if (attrs.required?.length) shape.requiredAttributes = attrs.required;
  }
  const rels = deref(data.properties?.relationships || {});
  if (rels.properties) {
    shape.relationships = {};
    for (const [k, v] of Object.entries(rels.properties)) {
      const d = deref(deref(v).properties?.data || {});
      const many = d.type === 'array';
      const item = deref(many ? d.items || {} : d);
      shape.relationships[k] = { types: deref(item.properties?.type || {}).enum || [], many: many || undefined };
    }
    if (rels.required?.length) shape.requiredRelationships = rels.required;
  }
  return shape;
}

const ops = [];
for (const [p, item] of Object.entries(spec.paths)) {
  const shared = item.parameters || [];
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'patch', 'delete', 'put'].includes(method)) continue;
    const params = [...shared, ...(op.parameters || [])].map(compactParam);
    ops.push({
      operationId: op.operationId,
      method: method.toUpperCase(),
      path: p,
      tag: (op.tags || [])[0] || '',
      deprecated: op.deprecated || undefined,
      hasBody: Boolean(op.requestBody) || undefined,
      body: bodyShape(op.requestBody),
      params,
    });
  }
}
ops.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

const outDir = path.join(ROOT, 'server', 'spec');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'asc-operations.json'),
  JSON.stringify({ specVersion: spec.info.version, generated: new Date().toISOString(), operations: ops }),
);

// ---- coverage report -------------------------------------------------------
const byTag = new Map();
for (const o of ops) {
  const t = byTag.get(o.tag) || { GET: 0, POST: 0, PATCH: 0, DELETE: 0 };
  t[o.method] = (t[o.method] || 0) + 1;
  byTag.set(o.tag, t);
}
const totals = ops.reduce((a, o) => ((a[o.method] = (a[o.method] || 0) + 1), a), {});
const has = (re, method) => ops.some((o) => re.test(o.path) && (!method || o.method === method));
const checks = [
  ['Create a brand-new app record', has(/^\/v1\/apps$/, 'POST')],
  ['Upload a build (buildUploads)', has(/^\/v1\/buildUploads$/, 'POST')],
  ['Submit a version for review (reviewSubmissions)', has(/^\/v1\/reviewSubmissions$/, 'POST')],
  ['Reply to customer reviews', has(/^\/v1\/customerReviewResponses$/, 'POST')],
  ['Upload screenshots', has(/^\/v1\/appScreenshots$/, 'POST')],
  ['Edit store-listing text (version localizations)', has(/^\/v1\/appStoreVersionLocalizations\/\{id\}$/, 'PATCH')],
  ['Phased release control', has(/^\/v1\/appStoreVersionPhasedReleases/, 'PATCH')],
  ['TestFlight groups and testers', has(/^\/v1\/betaTesters$/, 'POST')],
  ['Subscriptions and in-app purchases', has(/^\/v1\/subscriptions$/, 'POST')],
  ['App pricing', has(/^\/v1\/appPriceSchedules$/, 'POST')],
  ['Sales and finance reports', has(/^\/v1\/(salesReports|financeReports)$/, 'GET')],
  ['Analytics reports', has(/^\/v1\/analyticsReportRequests$/, 'POST')],
  ['App privacy / data-usage labels', has(/appDataUsages/)],
  // Account-level business items. (Per-app EULA endpoints like /v1/endUserLicenseAgreements are different.)
  ['Paid Apps agreement, tax and banking', has(/^\/v\d\/(agreements|contracts|taxForms|bankAccounts|paidApplicationsAgreement)/i)],
  ['Invite and manage users', has(/^\/v1\/userInvitations$/, 'POST')],
  ['Xcode Cloud', has(/^\/v1\/ciProducts/)],
];

let md = `# App Store Connect API coverage\n\nGenerated from Apple's official OpenAPI spec **v${spec.info.version}** on ${new Date().toISOString().slice(0, 10)}.\n\n`;
md += `**${ops.length} operations**: ${totals.GET || 0} reads (GET), ${totals.POST || 0} creates (POST), ${totals.PATCH || 0} edits (PATCH), ${totals.DELETE || 0} deletes (DELETE).\n\n`;
md += `## Notable capabilities (present in Apple's spec?)\n\n| Capability | In Apple's API |\n|---|---|\n`;
for (const [name, ok] of checks) md += `| ${name} | ${ok ? 'yes' : '**no (console only)**'} |\n`;
md += `\n"No" means the operation is not in Apple's published spec, so it cannot be done through any API client.\n\n## Operations by area\n\n| Area | GET | POST | PATCH | DELETE |\n|---|---|---|---|---|\n`;
for (const [t, c] of [...byTag.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  md += `| ${t} | ${c.GET} | ${c.POST} | ${c.PATCH} | ${c.DELETE} |\n`;
}
fs.writeFileSync(path.join(ROOT, 'COVERAGE.md'), md);

console.log(`Indexed ${ops.length} operations from spec v${spec.info.version}`);
for (const [name, ok] of checks) console.log(`${ok ? 'yes' : 'NO '}  ${name}`);
