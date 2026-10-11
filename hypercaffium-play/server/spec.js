// Search and look up methods in the bundled Google Play Developer API index.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let cache;

export function loadSpec() {
  if (!cache) cache = JSON.parse(fs.readFileSync(path.join(HERE, 'spec', 'play-methods.json'), 'utf8'));
  return cache;
}

export function searchMethods({ query = '', httpMethod, limit = 15 }) {
  const terms = query.toLowerCase().split(/[\s/.]+/).filter(Boolean);
  const hits = [];
  for (const m of loadSpec().methods) {
    if (httpMethod && m.method !== httpMethod.toUpperCase()) continue;
    const hay = `${m.id} ${m.path}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const idHits = terms.filter((t) => m.id.toLowerCase().includes(t)).length;
    hits.push({ m, score: idHits * 10 - m.path.length / 100 });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.min(limit, 50)).map(({ m }) => ({
    methodId: m.id,
    httpMethod: m.method,
    path: m.path,
    deprecated: m.deprecated,
  }));
}

export function getMethod(methodId) {
  return loadSpec().methods.find((m) => m.id === methodId);
}

// Splits a flat params map into path values and query values using the method's definition.
export function splitParams(method, params = {}) {
  const pathNames = new Set(method.params.filter((p) => p.in === 'path').map((p) => p.name));
  const pathValues = {};
  const query = {};
  for (const [k, v] of Object.entries(params)) {
    if (pathNames.has(k)) pathValues[k] = v;
    else query[k] = v;
  }
  return { pathValues, query, pathNames: [...pathNames] };
}

// `reserved` lists parameters (written {+name} in Google's description) whose values legitimately
// contain slashes, like "developers/123". Those are encoded piece by piece; all others as one piece.
export function fillPath(template, values = {}, reserved = []) {
  return template.replace(/\{([^}]+)\}/g, (_, rawName) => {
    const isPlus = rawName.startsWith('+'); // raw {+name} form from Google's description
    const name = isPlus ? rawName.slice(1) : rawName;
    const v = values[name];
    if (v === undefined || v === null || v === '') throw new Error(`Missing path parameter "${name}" for ${template}.`);
    const pieces = String(v).split('/');
    if (pieces.some((p) => p === '.' || p === '..')) throw new Error(`Path parameter "${name}" may not contain a dot-segment.`);
    if (isPlus || reserved.includes(name)) return pieces.map(encodeURIComponent).join('/');
    return encodeURIComponent(String(v));
  });
}
