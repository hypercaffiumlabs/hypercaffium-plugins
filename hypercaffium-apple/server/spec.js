// Search and look up operations in the bundled App Store Connect API index.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let cache;

export function loadSpec() {
  if (!cache) cache = JSON.parse(fs.readFileSync(path.join(HERE, 'spec', 'asc-operations.json'), 'utf8'));
  return cache;
}

export function searchOperations({ query = '', method, limit = 15 }) {
  const terms = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  const { operations } = loadSpec();
  const hits = [];
  for (const op of operations) {
    if (method && op.method !== method.toUpperCase()) continue;
    const hay = `${op.operationId} ${op.path} ${op.tag}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    // Rank: terms in the operationId first, plain resource paths before /relationships/ ones.
    const idHits = terms.filter((t) => op.operationId.toLowerCase().includes(t)).length;
    const penalty = op.path.includes('/relationships/') ? 5 : 0;
    hits.push({ op, score: idHits * 10 - penalty - op.path.length / 100 });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.min(limit, 50)).map(({ op }) => ({
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    area: op.tag,
    deprecated: op.deprecated || undefined,
  }));
}

export function getOperation(operationId) {
  return loadSpec().operations.find((o) => o.operationId === operationId);
}

export function fillPath(template, pathParams = {}) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    const v = pathParams[name];
    if (v === undefined || v === null || v === '') {
      throw new Error(`Missing path parameter "${name}" for ${template}. Pass it in pathParams.`);
    }
    if (String(v) === '.' || String(v) === '..') throw new Error(`Path parameter "${name}" may not be a dot-segment.`);
    return encodeURIComponent(String(v));
  });
}

// ---- request-body validation against Apple's real schema -------------------

const PLAIN_TYPES = new Set(['string', 'boolean', 'integer', 'number', 'object', 'date', 'date-time', 'uri', 'email', 'duration', 'int32', 'int64']);
const INTEGER_TYPES = new Set(['integer', 'int32', 'int64']);
const TEXT_TYPES = new Set(['string', 'date', 'date-time', 'uri', 'email', 'duration']);
// In the index an enum is written "A|B|C" (or a single ALL_CAPS value); format names are lowercase.
const isEnumLabel = (t) => t.includes('|') || /^[A-Z][A-Z0-9_]*$/.test(t);

// Returns a list of plain-language problems (empty = looks valid). Lenient where the index is silent.
export function validateBody(op, body, { creating = op.method === 'POST' } = {}) {
  const problems = [];
  const shape = op.body;
  if (!shape || !body || typeof body !== 'object') return problems;
  const data = body.data;
  if (data === undefined) {
    problems.push('The body must have a top-level "data" object.');
    return problems;
  }
  const items = Array.isArray(data) ? data : [data];
  for (const d of items) {
    if (!d || typeof d !== 'object') {
      problems.push('"data" must be an object (or a list of objects for relationship changes).');
      continue;
    }
    if (shape.type && d.type !== shape.type) {
      problems.push(`data.type must be "${shape.type}" (got ${JSON.stringify(d.type)}).`);
    }
    const attrs = d.attributes;
    if (attrs && typeof attrs === 'object') {
      if (!shape.attributes) {
        problems.push('This operation takes no attributes.');
      } else {
        for (const [k, v] of Object.entries(attrs)) {
          const t = shape.attributes[k];
          if (t === undefined) {
            problems.push(`Unknown attribute "${k}". Allowed: ${Object.keys(shape.attributes).join(', ')}.`);
            continue;
          }
          if (v === null || v === undefined) continue;
          if (t === 'boolean' && typeof v !== 'boolean') problems.push(`Attribute "${k}" must be true or false.`);
          else if (INTEGER_TYPES.has(t) && !Number.isInteger(v)) problems.push(`Attribute "${k}" must be a whole number.`);
          else if (TEXT_TYPES.has(t) && typeof v !== 'string') problems.push(`Attribute "${k}" must be text.`);
          else if (t === 'number' && typeof v !== 'number') problems.push(`Attribute "${k}" must be a number.`);
          else if (!PLAIN_TYPES.has(t) && !t.startsWith('array<') && !t.startsWith('enum(') && isEnumLabel(t)) {
            const allowed = t.split('|');
            if (!allowed.includes(String(v))) problems.push(`Attribute "${k}" must be one of: ${allowed.join(', ')} (got ${JSON.stringify(v)}).`);
          }
        }
      }
    }
    if (creating && shape.requiredAttributes) {
      for (const k of shape.requiredAttributes) {
        if (!attrs || attrs[k] === undefined) problems.push(`Missing required attribute "${k}".`);
      }
    }
    const rels = d.relationships;
    if (rels && typeof rels === 'object') {
      for (const [k, v] of Object.entries(rels)) {
        const r = shape.relationships?.[k];
        if (!r) {
          problems.push(`Unknown relationship "${k}". Allowed: ${Object.keys(shape.relationships || {}).join(', ') || '(none)'}.`);
          continue;
        }
        const rd = v?.data;
        const list = Array.isArray(rd) ? rd : rd ? [rd] : [];
        for (const e of list) {
          if (r.types?.length && !r.types.includes(e.type)) problems.push(`Relationship "${k}" must point to ${r.types.join(' or ')} (got ${JSON.stringify(e.type)}).`);
          if (!e.id) problems.push(`Relationship "${k}" needs an id.`);
        }
      }
    }
    if (creating && shape.requiredRelationships) {
      for (const k of shape.requiredRelationships) {
        if (!rels || !rels[k]) problems.push(`Missing required relationship "${k}".`);
      }
    }
  }
  return problems;
}
