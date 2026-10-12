process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareBetaReview } from './extras.js';
import { applyChange, TicketStore } from './writes.js';

const res = (type, id, attributes = {}) => ({ id, type, attributes });
function fake(overrides = {}) {
  const calls = [];
  const routes = {
    'GET /v1/builds': { data: [res('builds', 'B57', { version: '57', processingState: 'VALID', expired: false, usesNonExemptEncryption: false })] },
    'GET /v1/builds/B57/betaAppReviewSubmission': { data: null },
    'GET /v1/builds/B57/betaBuildLocalizations': { data: [res('betaBuildLocalizations', 'L1', { locale: 'en-US', whatsNew: 'Try the new queen tracker' })] },
    'GET /v1/apps/A1/betaAppLocalizations': { data: [res('betaAppLocalizations', 'AL', { locale: 'en-US', description: 'A beekeeping app', feedbackEmail: 'test@example.com' })] },
    'GET /v1/apps/A1/betaAppReviewDetail': {
      data: res('betaAppReviewDetails', 'A1', { contactFirstName: 'Pat', contactLastName: 'Lee', contactPhone: '+15551234567', contactEmail: 'pat@example.com', demoAccountRequired: false }),
    },
    'POST /v1/betaAppReviewSubmissions': { data: res('betaAppReviewSubmissions', 'S1', { betaReviewState: 'WAITING_FOR_REVIEW' }) },
    ...overrides,
  };
  const handle = (method, p, body) => {
    const key = `${method} ${p.split('?')[0]}`;
    if (!(key in routes)) throw new Error(`fake: no route for ${key}`);
    const h = routes[key];
    if (h instanceof Error) throw h;
    return typeof h === 'function' ? h(body) : h;
  };
  return {
    calls,
    store: new TicketStore(),
    writesEnabled: () => true,
    get: async (p) => handle('GET', p),
    send: async (method, p, _q, body) => {
      calls.push({ method, path: p, body });
      return handle(method, p, body);
    },
  };
}

test('beta review: a ready build gets a Tier 2 ticket, and applying submits exactly that build', async () => {
  const d = fake();
  const p = await prepareBetaReview(d, { appId: 'A1', buildNumber: '57' });
  assert.equal(p.readyForBetaReview, true);
  assert.equal(p.allowed, true);
  assert.equal(p.tier, 2);
  assert.equal(p.feature, 'testing');
  assert.equal(d.calls.length, 0, 'the preview sends nothing');
  const out = await applyChange({ ticketId: p.ticket, deps: d });
  assert.equal(out.applied, true);
  assert.equal(d.calls[0].path, '/v1/betaAppReviewSubmissions');
  assert.equal(d.calls[0].body.data.relationships.build.data.id, 'B57');
});

test('beta review: missing requirements are listed and NO ticket is issued', async () => {
  const d = fake({
    'GET /v1/builds': { data: [res('builds', 'B57', { version: '57', processingState: 'VALID', expired: false, usesNonExemptEncryption: null })] },
    'GET /v1/builds/B57/betaBuildLocalizations': { data: [] },
    'GET /v1/apps/A1/betaAppLocalizations': { data: [res('betaAppLocalizations', 'AL', { locale: 'en-US', description: '' })] },
    'GET /v1/apps/A1/betaAppReviewDetail': { data: res('betaAppReviewDetails', 'A1', { contactEmail: 'pat@example.com', demoAccountRequired: true }) },
  });
  const p = await prepareBetaReview(d, { appId: 'A1', buildNumber: '57' });
  assert.equal(p.allowed, false);
  assert.equal(p.ticket, undefined);
  const text = p.problems.join(' | ');
  for (const re of [/Export compliance/, /What to Test/, /feedback email/, /contactFirstName/, /demo account/]) assert.match(text, re);
});

test('beta review: an already submitted build is reported with its state, not resubmitted', async () => {
  const d = fake({ 'GET /v1/builds/B57/betaAppReviewSubmission': { data: res('betaAppReviewSubmissions', 'S0', { betaReviewState: 'IN_REVIEW' }) } });
  const p = await prepareBetaReview(d, { appId: 'A1', buildNumber: '57' });
  assert.equal(p.allowed, false);
  assert.equal(p.alreadySubmitted, true);
  assert.equal(p.betaReviewState, 'IN_REVIEW');
});

test('beta review: an unprocessed or expired build is refused', async () => {
  const d = fake({ 'GET /v1/builds': { data: [res('builds', 'B57', { version: '57', processingState: 'PROCESSING', expired: true, usesNonExemptEncryption: false })] } });
  const p = await prepareBetaReview(d, { appId: 'A1', buildNumber: '57' });
  assert.equal(p.allowed, false);
  assert.match(p.problems.join(' '), /not VALID yet.*expired/s);
});
