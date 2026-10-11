// Multi-step plans: several dependent changes approved ONCE and run in order.
// Apple has no all-or-nothing, so a failure stops the plan and reports exactly what did and did not happen.
import { classify } from './rules.js';
import { getOperation, loadSpec, validateBody } from './spec.js';
import { toLocalTime } from './util.js';

export const MAX_STEPS = 250;
const PLACEHOLDER = /\{\{(\d+)\.([A-Za-z0-9_]+)\}\}/g;
const WHOLE = /^\{\{(\d+)\.([A-Za-z0-9_]+)\}\}$/;

export const hasPlaceholder = (v) => JSON.stringify(v ?? null).includes('{{');

function lookup(results, n, key) {
  const r = results[n];
  if (!r) throw new Error(`Step ${n} has not run yet, so {{${n}.${key}}} cannot be resolved.`);
  const v = key === 'id' ? r.id : r.attributes?.[key];
  if (v === undefined) throw new Error(`Step ${n} returned no "${key}".`);
  return v;
}

// Replace {{N.id}} / {{N.attribute}} using results of earlier steps.
export function resolveValue(value, results) {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole) return lookup(results, Number(whole[1]), whole[2]);
    return value.replace(PLACEHOLDER, (_, n, k) => String(lookup(results, Number(n), k)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, results));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, results)]));
  }
  return value;
}

export const findOperation = (method, path) =>
  loadSpec().operations.find((o) => o.method === method.toUpperCase() && o.path === path);

// Path with real values encoded and placeholders left readable (for previews).
function previewPath(template, pathParams = {}) {
  return template.replace(/\{([^}]+)\}/g, (_, name) => {
    const v = pathParams[name];
    if (v === undefined) return `{${name}}`;
    return String(v).includes('{{') ? String(v) : encodeURIComponent(String(v));
  });
}

const stepPath = (op, pathParams, results) => {
  const resolved = resolveValue(pathParams || {}, results);
  return op.path.replace(/\{([^}]+)\}/g, (_, name) => {
    const v = resolved[name];
    if (v === undefined || v === '') throw new Error(`Missing path parameter "${name}" for ${op.path}.`);
    if (String(v) === '.' || String(v) === '..') throw new Error(`Path parameter "${name}" may not be a dot-segment.`);
    return encodeURIComponent(String(v));
  });
};

// ---- prepare ---------------------------------------------------------------

// steps: [{ label, method, path (template like /v1/reviewSubmissions/{id}), pathParams, query, body }]
export async function preparePlan({ title, steps, deps }) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('A plan needs at least one step.');
  if (steps.length > MAX_STEPS) throw new Error(`A plan may have at most ${MAX_STEPS} steps.`);

  const resolvedSteps = [];
  const previews = [];
  let worst = 1;
  for (const [i, s] of steps.entries()) {
    const op = s.operationId ? getOperation(s.operationId) : findOperation(s.method, s.path);
    if (!op) throw new Error(`Step ${i}: no such API operation (${s.operationId || `${s.method} ${s.path}`}).`);
    if (op.method === 'GET') throw new Error(`Step ${i}: ${op.operationId} only reads data; plans are for changes.`);

    const early = await classify(
      op,
      op.path.replace(/\{[^}]+\}/g, 'x'),
      async () => {
        throw new Error('no lookup');
      },
      { early: true },
    );
    if (early.tier === 3) {
      return { allowed: false, tier: 3, blocked: true, reason: `Step ${i} (${s.label || op.operationId}): ${early.reason}` };
    }
    const problems = validateBody(op, s.body);
    if (problems.length) throw new Error(`Step ${i} (${s.label || op.operationId}) has an invalid body:\n- ${problems.join('\n- ')}`);

    const placeholders = hasPlaceholder(s.pathParams) || hasPlaceholder(s.body);
    let verdict;
    if (placeholders) {
      verdict = { tier: Math.max(2, early.tier), reason: 'depends on an earlier step in this plan' };
    } else {
      const filled = stepPath(op, s.pathParams, []);
      verdict = await classify(op, filled, deps.get);
    }
    if (verdict.tier === 3) return { allowed: false, tier: 3, blocked: true, reason: `Step ${i}: ${verdict.reason}` };
    worst = Math.max(worst, verdict.tier);
    resolvedSteps.push({ op, pathParams: s.pathParams || {}, query: s.query || {}, body: s.body, tier: verdict.tier, label: s.label || op.operationId });
    previews.push({
      step: i,
      label: s.label || op.operationId,
      operation: { operationId: op.operationId, method: op.method, path: previewPath(op.path, s.pathParams) },
      tier: verdict.tier,
      tierReason: verdict.reason,
      requestBody: s.body,
    });
  }

  const ticket = deps.store.create({ kind: 'plan', title, steps: resolvedSteps, tier: worst });
  return {
    allowed: true,
    kind: 'plan',
    title,
    tier: worst,
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    stepCount: previews.length,
    steps: previews,
    note: 'Steps run in order. If one fails the plan stops, and the result lists exactly what was done and what was not.',
    nextStep:
      worst === 1
        ? 'Low risk. Apply with asc_apply_safe_change (or asc_apply_change).'
        : 'Show this plan to the owner in plain English and wait for their explicit "yes", then apply with asc_apply_change.',
  };
}

// ---- apply -----------------------------------------------------------------

const simplifyData = (body) => {
  const d = body?.data;
  return d && !Array.isArray(d) ? { id: d.id, type: d.type, attributes: d.attributes } : { id: undefined, attributes: undefined };
};

export async function applyPlanPayload({ payload, deps }) {
  const results = [];
  const done = [];
  for (const [i, s] of payload.steps.entries()) {
    try {
      const filled = stepPath(s.op, s.pathParams, results);
      const verdict = await classify(s.op, filled, deps.get);
      if (verdict.tier === 3) throw new Error(`Blocked: ${verdict.reason}`);
      if (verdict.tier > s.tier) throw new Error(`The situation changed since the preview (${verdict.reason}).`);
      const body = s.body === undefined ? undefined : resolveValue(s.body, results);
      const response = await deps.send(s.op.method, filled, resolveValue(s.query, results), body);
      results[i] = simplifyData(response);
      done.push({ step: i, label: s.label, operation: `${s.op.method} ${filled}`, id: results[i].id });
    } catch (err) {
      return {
        applied: false,
        partial: done.length > 0,
        tier: payload.tier,
        title: payload.title,
        completed: done,
        failedStep: { step: i, label: s.label, error: String(err.message || err) },
        notExecuted: payload.steps.slice(i + 1).map((x, k) => ({ step: i + 1 + k, label: x.label })),
        advice: done.length
          ? 'Some steps already took effect (listed in "completed"). Check the current state before retrying; do not blindly re-run the plan.'
          : 'Nothing was changed.',
      };
    }
  }
  return { applied: true, tier: payload.tier, title: payload.title, completed: done };
}
