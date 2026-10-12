// The two-step write engine for Google Play: prepare (preview + ticket) then apply (execute exactly that).
// On Play, changes live inside an "edit" that is committed all-or-nothing, so one ticket may bundle
// several changes. Network access is injected so every rule here can be tested offline.
import crypto from 'node:crypto';
import { classify, currentFeatures } from './rules.js';
import { fillPath, getMethod, splitParams } from './spec.js';
import { toLocalTime } from './util.js';

const MAX_BODY_CHARS = 100_000;
const MAX_CHANGES = 10;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// ---- tickets (same behavior as the Apple plugin) ----------------------------

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

// Play resources are flat objects, so a diff is just top-level fields.
export function diffFields(before, body) {
  if (!body || typeof body !== 'object') return [];
  return Object.entries(body).map(([field, to]) => ({
    field,
    from: before && field in before ? before[field] : '(not set or unknown)',
    to,
    unchanged: Boolean(before) && JSON.stringify(before[field]) === JSON.stringify(to),
  }));
}

// "edits.listings.update" -> "edits.listings.get" (the matching read, for the "before" picture).
const siblingGetId = (id) => id.replace(/\.[^.]+$/, '.get');

function resolveChange(raw, defaultPackage) {
  const m = getMethod(raw.methodId);
  if (!m) throw new Error(`Unknown methodId "${raw.methodId}". Use play_search_api to find one.`);
  if (m.method === 'GET') throw new Error(`${m.id} only reads data. Use play_call for reads.`);
  if (m.mediaUpload) {
    throw new Error(`${m.id} uploads a file. File uploads (bundles, images) arrive in Phase 3 with their own workflow.`);
  }
  const { pathValues, query, pathNames } = splitParams(m, raw.params || {});
  // Most methods act on one app; account-level ones (team members) take a developer path instead.
  if (pathNames.includes('packageName')) {
    if (!pathValues.packageName) pathValues.packageName = defaultPackage;
    if (!pathValues.packageName || !/^[A-Za-z0-9._]+$/.test(pathValues.packageName)) {
      throw new Error('A valid packageName is required (or set defaultPackageName in the config file).');
    }
  }
  if (m.hasBody && (raw.body === undefined || raw.body === null)) throw new Error(`${m.id} needs a body.`);
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body !== 'object' || Array.isArray(raw.body)) throw new Error('A body must be a JSON object.');
    if (JSON.stringify(raw.body).length > MAX_BODY_CHARS) throw new Error('The request body is too large.');
  }
  return {
    method: m,
    pathValues,
    query,
    body: raw.body,
    editScoped: pathNames.includes('editId'),
    reserved: m.params.filter((p) => p.reserved).map((p) => p.name),
  };
}

// A comparable fingerprint of a track's releases (status, version codes, rollout fraction).
const trackPrint = (track) =>
  JSON.stringify(((track && track.releases) || []).map((r) => [r.status, (r.versionCodes || []).map(String).sort(), r.userFraction ?? null]));

// ---- prepare ---------------------------------------------------------------

export async function prepareChange({ changes, deps }) {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('Provide at least one change.');
  if (changes.length > MAX_CHANGES) throw new Error(`At most ${MAX_CHANGES} changes per ticket.`);

  // Safety verdict FIRST, so a blocked method is always reported as blocked (never as a parameter error).
  for (const c of changes) {
    const m = getMethod(c.methodId);
    if (!m) throw new Error(`Unknown methodId "${c.methodId}". Use play_search_api to find one.`);
    if (m.method === 'GET') throw new Error(`${m.id} only reads data. Use play_call for reads.`);
    const v = classify(m);
    if (v.tier === 3) {
      return {
        allowed: false,
        tier: 3,
        blocked: true,
        reason: v.reason,
        operations: [{ methodId: m.id, httpMethod: m.method, path: m.path }],
      };
    }
  }

  const resolved = changes.map((c) => resolveChange(c, deps.defaultPackage()));

  const pkg = resolved[0].pathValues.packageName;
  if (resolved.some((r) => r.pathValues.packageName !== pkg)) throw new Error('All changes in one ticket must be for the same app.');
  const scopedCount = resolved.filter((r) => r.editScoped).length;
  if (scopedCount !== 0 && scopedCount !== resolved.length) {
    throw new Error('Do not mix edit-based changes (listings, tracks, ...) with direct ones (review replies, ...) in one ticket.');
  }
  if (scopedCount === 0 && resolved.length > 1) throw new Error('Direct (non-edit) changes must be prepared one at a time.');

  const verdicts = resolved.map((r) => classify(r.method));
  const worst = Math.max(...verdicts.map((v) => v.tier));
  const sensitive = verdicts.some((v) => v.sensitive);
  const operations = resolved.map((r) => ({
    methodId: r.method.id,
    httpMethod: r.method.method,
    path: fillPath(r.method.path, { ...r.pathValues, editId: r.editScoped ? 'NEW_EDIT' : undefined }, r.reserved),
  }));
  if (worst === 3) {
    const blocked = verdicts.find((v) => v.tier === 3);
    return { allowed: false, tier: 3, blocked: true, reason: blocked.reason, operations };
  }

  // "Before" pictures: read the matching resource (inside a throwaway edit when needed).
  const befores = await deps.withReadContext(pkg, scopedCount > 0, async (editId) => {
    const out = [];
    for (const r of resolved) {
      const sib = getMethod(siblingGetId(r.method.id));
      if (!sib || sib.method !== 'GET') {
        out.push({ before: null, note: 'no matching read method for a "before" picture' });
        continue;
      }
      try {
        const values = { ...r.pathValues, ...(r.editScoped ? { editId } : {}) };
        const path = fillPath(sib.path, values, sib.params.filter((p) => p.reserved).map((p) => p.name));
        out.push({ before: await deps.get(path, {}) });
      } catch (err) {
        out.push({ before: null, note: `could not read the current state: ${err.message}` });
      }
    }
    return out;
  });

  const ticket = deps.store.create({ resolved, tier: worst, sensitive, pkg, editScoped: scopedCount > 0, befores: befores.map((b) => b.before) });
  return {
    allowed: true,
    tier: worst,
    tierReason: (verdicts.find((v) => v.sensitive) || verdicts.find((v) => v.tier === worst)).reason,
    sensitive: sensitive || undefined,
    feature: [...new Set(verdicts.map((v) => v.feature))].join(', '),
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    app: pkg,
    committedTogether: scopedCount > 0 ? 'All changes below are applied inside ONE Play edit and committed together, or not at all.' : undefined,
    changes: resolved.map((r, i) => ({
      ...operations[i],
      fieldChanges: diffFields(befores[i].before, r.body),
      before: befores[i].before,
      beforeNote: befores[i].note,
      requestBody: r.body,
    })),
    nextStep: nextStepFor(worst, sensitive),
  };
}

export function nextStepFor(tier, sensitive) {
  if (sensitive) {
    return 'CRITICAL change. Show this preview to the owner in plain English, say plainly what could go wrong, and wait for their explicit "yes". Then apply with play_apply_sensitive_change (play_apply_change refuses it).';
  }
  return tier === 1
    ? 'Low risk. Apply with play_apply_safe_change (or play_apply_change).'
    : 'Show this preview to the owner in plain English and wait for their explicit "yes", then apply with play_apply_change.';
}

// Sensitive tickets need the sensitive apply tool, and that tool takes nothing else. Keeping the two
// apart means an "always allow" on play_apply_change can never cover a critical change.
export function checkApplyTool(payload, { requireTier1 = false, sensitiveTool = false } = {}) {
  if (payload.sensitive && !sensitiveTool) {
    throw new Error('This is a CRITICAL change (users, signing or refunds). It can only be applied with play_apply_sensitive_change, after the owner says yes.');
  }
  if (!payload.sensitive && sensitiveTool) {
    throw new Error('play_apply_sensitive_change only applies critical changes. Use play_apply_change (or play_apply_safe_change) for this ticket.');
  }
  if (requireTier1 && payload.tier !== 1) {
    throw new Error('This ticket is not low-risk (Tier 2). It must be applied with play_apply_change so the owner is asked first.');
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
  // Image uploads carry their own execution logic (a media upload inside one Play edit).
  if (p.kind === 'bundle') {
    deps.store.markUsed(ticketId);
    return deps.runBundle(p);
  }
  if (p.kind === 'images') {
    if (!currentFeatures().listing) throw new Error('The "listing" feature was switched off since the preview, so this upload is refused.');
    deps.store.markUsed(ticketId);
    return deps.runImages(p);
  }
  // Re-check the rules right now (they could have been tightened since the preview).
  const now = p.resolved.map((r) => classify(r.method));
  const worst = Math.max(...now.map((v) => v.tier));
  if (worst === 3) throw new Error(`Blocked: ${now.find((v) => v.tier === 3).reason}`);
  if (now.some((v) => v.sensitive) !== Boolean(p.sensitive)) throw new Error('The rules changed since the preview. Prepare the change again.');
  if (worst > p.tier) throw new Error('The rules changed since the preview. Prepare the change again.');

  deps.store.markUsed(ticketId); // single use, even if a request below fails
  const pkg = p.pkg;

  if (!p.editScoped) {
    const r = p.resolved[0];
    const result = await deps.send(r.method.method, fillPath(r.method.path, r.pathValues, r.reserved), r.query, r.body);
    return { applied: true, tier: p.tier, app: pkg, results: [{ methodId: r.method.id, response: result }], before: p.befores };
  }

  // Edit-based: open an edit, apply every change, commit once. Any failure discards the edit.
  const edit = await deps.send('POST', `/androidpublisher/v3/applications/${pkg}/edits`, {}, {});
  const results = [];
  try {
    // A track change replaces the track's whole release list, so it must start from exactly what the
    // owner saw. If a rollout or release happened since the preview, stop instead of overwriting it.
    for (const [i, r] of p.resolved.entries()) {
      if (!/^edits\.tracks\.(update|patch)$/.test(r.method.id) || !p.befores?.[i]) continue;
      const path = fillPath(r.method.path, { ...r.pathValues, editId: edit.id }, r.reserved);
      const now = await deps.get(path, {});
      if (trackPrint(now) !== trackPrint(p.befores[i])) {
        throw new Error(`The "${r.pathValues.track}" track changed since the preview (a release or rollout happened in the meantime). Nothing was committed; prepare the change again.`);
      }
    }
    for (const r of p.resolved) {
      const path = fillPath(r.method.path, { ...r.pathValues, editId: edit.id }, r.reserved);
      try {
        results.push({ methodId: r.method.id, response: await deps.send(r.method.method, path, r.query, r.body) });
      } catch (err) {
        throw new Error(`Change ${results.length + 1} of ${p.resolved.length} (${r.method.id}) failed: ${err.message}. Nothing was committed.`);
      }
    }
    const commit = await deps.send('POST', `/androidpublisher/v3/applications/${pkg}/edits/${edit.id}:commit`, {}, undefined);
    return { applied: true, tier: p.tier, app: pkg, committed: true, results, commit, before: p.befores };
  } catch (err) {
    await deps.send('DELETE', `/androidpublisher/v3/applications/${pkg}/edits/${edit.id}`, {}, undefined).catch(() => {});
    throw err;
  }
}
