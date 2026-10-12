// The two-step write engine: prepare (preview + ticket) then apply (execute exactly that).
// Network access is injected so every rule here can be tested offline.
import crypto from 'node:crypto';
import { classify, currentFeatures } from './rules.js';
import { applyPlanPayload } from './plans.js';
import { fillPath, validateBody as validateSchema } from './spec.js';
import { toLocalTime } from './util.js';

const MAX_BODY_CHARS = 100_000;

// ---- tickets ---------------------------------------------------------------

export class TicketStore {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.tickets = new Map();
  }

  create(payload) {
    const id = crypto.randomBytes(9).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(id, { id, payload, expiresAt, used: false });
    return { id, expiresAt };
  }

  // Look at a ticket without using it up.
  peek(id) {
    const t = this.tickets.get(id);
    if (!t) throw new Error('Unknown ticket. Prepare the change again (tickets only live in this session).');
    if (t.used) throw new Error('That ticket was already applied. Tickets work once.');
    if (this.now() > t.expiresAt) {
      this.tickets.delete(id);
      throw new Error('That ticket expired (10 minutes). Prepare the change again to get a fresh preview.');
    }
    return t;
  }

  markUsed(id) {
    const t = this.tickets.get(id);
    if (t) t.used = true;
  }
}

// ---- helpers ---------------------------------------------------------------

const flattenResource = (r) => (r ? { id: r.id, type: r.type, ...(r.attributes || {}) } : null);

// For PATCH bodies: which attributes change, from what, to what.
export function diffAttributes(beforeFlat, body) {
  const attrs = body?.data?.attributes;
  if (!attrs || typeof attrs !== 'object') return [];
  return Object.entries(attrs).map(([field, to]) => ({
    field,
    from: beforeFlat && field in beforeFlat ? beforeFlat[field] : '(not set or unknown)',
    to,
    unchanged: Boolean(beforeFlat) && JSON.stringify(beforeFlat[field]) === JSON.stringify(to),
  }));
}

function validateBody(op, pathParams, body) {
  if (op.hasBody && (body === undefined || body === null)) {
    throw new Error(`${op.operationId} needs a request body (JSON:API shape: {"data": {"type": ..., ...}}).`);
  }
  if (!op.hasBody && body !== undefined && body !== null) {
    throw new Error(`${op.operationId} does not take a request body.`);
  }
  if (body === undefined || body === null) return;
  if (typeof body !== 'object' || Array.isArray(body)) throw new Error('The request body must be a JSON object.');
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw new Error('The request body is too large.');
  // Classic mistake: the id in the body must match the id in the path.
  // (Not for /relationships/ endpoints: there, data.id is the id of the OTHER object being linked.)
  if (
    op.method === 'PATCH' &&
    !op.path.includes('/relationships/') &&
    body.data &&
    !Array.isArray(body.data) &&
    pathParams?.id &&
    body.data.id &&
    String(body.data.id) !== String(pathParams.id)
  ) {
    throw new Error(`data.id (${body.data.id}) must match the id in the path (${pathParams.id}).`);
  }
}

// ---- prepare ---------------------------------------------------------------

export async function prepareChange({ op, pathParams = {}, query = {}, body, deps }) {
  if (op.method === 'GET') throw new Error(`${op.operationId} only reads data. Use asc_call for reads.`);

  // Safety verdict FIRST, so a blocked operation is always reported as blocked (never as a parameter error).
  const early = await classify(
    op,
    op.path.replace(/\{[^}]+\}/g, 'x'),
    async () => {
      throw new Error('no lookup');
    },
    { early: true },
  );
  if (early.tier === 3) {
    return {
      allowed: false,
      tier: 3,
      blocked: true,
      reason: early.reason,
      operation: { operationId: op.operationId, method: op.method, path: op.path },
    };
  }

  validateBody(op, pathParams, body);
  const schemaProblems = validateSchema(op, body);
  if (schemaProblems.length) {
    throw new Error(`The request body does not match Apple's schema for ${op.operationId}:\n- ${schemaProblems.join('\n- ')}`);
  }
  const filledPath = fillPath(op.path, pathParams);

  const verdict = await classify(op, filledPath, deps.get);
  const operation = { operationId: op.operationId, method: op.method, path: filledPath };
  if (verdict.tier === 3) {
    return { allowed: false, tier: 3, blocked: true, reason: verdict.reason, operation };
  }

  // The "before" picture: current state of the thing being edited (PATCH only; POST creates new).
  let before = null;
  let beforeNote;
  if (op.method === 'PATCH' || op.method === 'DELETE') {
    try {
      const got = await deps.get(filledPath);
      before = got?.data && !Array.isArray(got.data) ? flattenResource(got.data) : null;
      if (!before) beforeNote = 'no readable current state for this resource';
    } catch (err) {
      beforeNote = `could not read the current state: ${err.message}`;
    }
  }

  const changes = diffAttributes(before, body);
  const sensitive = Boolean(verdict.sensitive);
  const ticket = deps.store.create({ op, pathParams, query, body, filledPath, tier: verdict.tier, before, sensitive, feature: verdict.feature });
  return {
    allowed: true,
    tier: verdict.tier,
    tierReason: verdict.reason,
    feature: verdict.feature,
    sensitive: sensitive || undefined,
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    operation,
    changes: changes.length ? changes : undefined,
    before,
    beforeNote,
    requestBody: body,
    nextStep: nextStepFor(verdict.tier, sensitive),
  };
}

export function nextStepFor(tier, sensitive) {
  if (sensitive) {
    return 'CRITICAL change. Show this preview to the owner in plain English, say plainly what could go wrong, and wait for their explicit "yes". Then apply with asc_apply_sensitive_change (asc_apply_change refuses it).';
  }
  return tier === 1
    ? 'Low risk. Apply with asc_apply_safe_change (or asc_apply_change).'
    : 'Show this preview to the owner in plain English and wait for their explicit "yes", then apply with asc_apply_change.';
}

// Sensitive tickets need the sensitive apply tool, and that tool takes nothing else. Keeping the two
// apart means an "always allow" on asc_apply_change can never cover a critical change.
export function checkApplyTool(payload, { requireTier1 = false, sensitiveTool = false } = {}) {
  if (payload.sensitive && !sensitiveTool) {
    throw new Error('This is a CRITICAL change (users or signing). It can only be applied with asc_apply_sensitive_change, after the owner says yes.');
  }
  if (!payload.sensitive && sensitiveTool) {
    throw new Error('asc_apply_sensitive_change only applies critical changes. Use asc_apply_change (or asc_apply_safe_change) for this ticket.');
  }
  if (requireTier1 && payload.tier !== 1) {
    throw new Error('This ticket is not low-risk (Tier 2). It must be applied with asc_apply_change so the owner is asked first.');
  }
}

// ---- apply -----------------------------------------------------------------

export async function applyChange({ ticketId, requireTier1 = false, sensitiveTool = false, deps }) {
  if (!deps.writesEnabled()) {
    throw new Error(
      'Writes are switched off (kill switch). To allow changes, set "writesEnabled": true in the plugin config file. Previews still work.',
    );
  }
  const ticket = deps.store.peek(ticketId);
  const p = ticket.payload;
  checkApplyTool(p, { requireTier1, sensitiveTool });

  // Multi-step plans and screenshot uploads carry their own execution logic.
  if (p.kind === 'plan') {
    deps.store.markUsed(ticketId);
    return applyPlanPayload({ payload: p, deps });
  }
  if (p.kind === 'screenshots') {
    if (!currentFeatures().listing) throw new Error('The "listing" feature was switched off since the preview, so this upload is refused.');
    deps.store.markUsed(ticketId);
    return deps.runScreenshots(p);
  }

  // Re-check the tier right now: state may have changed since the preview (e.g. version went into review).
  const verdict = await classify(p.op, p.filledPath, deps.get);
  if (verdict.tier === 3) throw new Error(`Blocked: ${verdict.reason}`);
  if (verdict.tier > p.tier || Boolean(verdict.sensitive) !== Boolean(p.sensitive)) {
    throw new Error(`The situation changed since the preview (${verdict.reason}). Prepare the change again.`);
  }

  deps.store.markUsed(ticketId); // single use, even if the request below fails
  const result = await deps.send(p.op.method, p.filledPath, p.query, p.body);
  return {
    applied: true,
    tier: p.tier,
    operation: { operationId: p.op.operationId, method: p.op.method, path: p.filledPath },
    before: p.before,
    result,
  };
}
