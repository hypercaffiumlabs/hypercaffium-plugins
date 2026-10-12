#!/usr/bin/env node
// App Store Connect MCP server. PHASE 2b: FULL API COVERAGE + GUARDED WRITES.
// Reads are plain HTTP GETs. Changes only happen through a two-step flow: asc_prepare_change
// (preview + one-time ticket) then asc_apply_change / asc_apply_safe_change (executes exactly
// that ticket), and only when the kill switch ("writesEnabled") is on. Everything is audited.
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { audit, readAudit } from './audit.js';
import { CONFIG_PATH, configProblems, getToken, loadConfig } from './auth.js';
import { API_ORIGIN, assertApiUrl, ascGet, ascGetUrl } from './client.js';
import { fillPath, getOperation, loadSpec, searchOperations } from './spec.js';
import { buildAppleStatus } from './status.js';
import { limitText, toLocalTime } from './util.js';
import { applyChange, prepareChange, TicketStore } from './writes.js';
import { currentFeatures, setFeatureSource } from './rules.js';
import { describeFeatures, isCritical, saveSettings } from '../../shared/features.js';
import { appleCheckChanges } from './monitor.js';
import { preparePlan } from './plans.js';
import {
  prepareAttachBuild,
  prepareCancelSubmission,
  prepareCreateVersion,
  prepareListingEdit,
  preparePhasedRelease,
  prepareReleaseNow,
  prepareSubmit,
  releaseOverview,
} from './release.js';
import { prepareClearScreenshots, prepareScreenshots, runScreenshots } from './screenshots.js';
import {
  prepareAddBuildToGroup,
  prepareAddTester,
  prepareAppInfo,
  prepareReplyToReview,
  prepareReviewDetails,
  prepareTestflightNotes,
  reviewInbox,
  testflightOverview,
} from './extras.js';
import {
  findPricePoint,
  prepareEditSubscription,
  prepareEditSubscriptionLocalization,
  prepareIntroOffer,
  prepareSetPrice,
  subscriptionOverview,
  subscriptionPrices,
} from './subs.js';

const PLUGIN = 'app-store-connect';

// Show times in the owner's zone (config "timezone"); default is the computer's own.
{
  const tz = loadConfig().timezone;
  if (tz && !process.env.HYPERCAFFIUM_TIMEZONE) process.env.HYPERCAFFIUM_TIMEZONE = tz;
}

// Feature switches are re-read from the settings file on every check, so switching one OFF takes
// effect at once. Which dedicated tools exist is decided here, at startup (a restart shows new ones).
setFeatureSource(() => loadConfig().features);
const STARTUP_FEATURES = currentFeatures();

// The terminal setup menu sits next to this server file once built (server/dist/setup.mjs).
const SETUP_SCRIPT = (() => {
  const here = fileURLToPath(import.meta.url);
  return /[\\/]dist[\\/][^\\/]+$/.test(here) ? fileURLToPath(new URL('./setup.mjs', import.meta.url)) : fileURLToPath(new URL('./dist/setup.mjs', import.meta.url));
})();

// The ONLY function in this server that can change anything. It is referenced solely by the
// apply path (writeDeps.send below), after a valid, unexpired, single-use ticket has been checked.
async function ascSend(method, pathname, query = {}, body) {
  const url = new URL(pathname, API_ORIGIN);
  assertApiUrl(url);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${getToken()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return { status: 204 };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (json.errors || []).map((e) => `${e.status} ${e.title}: ${e.detail}`).join('; ');
    throw new Error(`Apple API ${res.status} for ${method} ${url.pathname}${detail ? ` -> ${detail}` : ''}`);
  }
  return json;
}

const ticketStore = new TicketStore();
const writeDeps = {
  store: ticketStore,
  get: (p) => ascGet(p),
  send: ascSend,
  writesEnabled: () => loadConfig().writesEnabled,
};

writeDeps.runScreenshots = (payload) => runScreenshots(payload, writeDeps);

// Apple returns {id, type, attributes:{...}}; flatten to {id, type, ...attributes}.
const flatten =(r) => ({ id: r.id, type: r.type, ...(r.attributes || {}) });
const flattenList = (body) => (body.data || []).map(flatten);

// A friendlier shape for arbitrary API responses.
function simplify(body) {
  const out = {};
  if (body.data !== undefined) out.data = Array.isArray(body.data) ? body.data.map(flatten) : body.data && flatten(body.data);
  if (body.included) out.included = body.included.map(flatten);
  if (body.links?.next) out.nextPage = body.links.next;
  if (body.meta) out.meta = body.meta;
  return out;
}

const ok = (value) => ({ content: [{ type: 'text', text: limitText(JSON.stringify(value, null, 2)) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

const server = new McpServer({ name: 'hypercaffium-apple', version: '0.9.0' });

// Every tool goes through here so every call is audited, success or failure.
function readTool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema, annotations: READ_ONLY }, async (args) => {
    const started = Date.now();
    try {
      const result = await handler(args || {});
      audit(PLUGIN, { tool: name, kind: 'read', args, ok: true, ms: Date.now() - started });
      return ok(result);
    } catch (err) {
      audit(PLUGIN, { tool: name, kind: 'read', args, ok: false, ms: Date.now() - started, error: String(err.message || err) });
      return fail(err);
    }
  });
}

// A dedicated change tool exists only while its feature is switched on (decided at startup).
function featureTool(feature, ...args) {
  if (STARTUP_FEATURES[feature]) readTool(...args);
}

// ---- setup + dedicated read tools -----------------------------------------

readTool(
  'asc_check_setup',
  'Check whether App Store Connect credentials are configured and accepted by Apple. Run this first if any other asc_ tool fails.',
  {},
  async () => {
    const cfg = loadConfig();
    const problems = configProblems(cfg);
    if (problems.length) return { configured: false, configFile: CONFIG_PATH, problems };
    const body = await ascGet('/v1/apps', { limit: 1 });
    return {
      configured: true,
      apiAccepted: true,
      appsVisible: body.meta?.paging?.total ?? 'unknown',
      writesEnabled: cfg.writesEnabled,
      featuresChosen: cfg.configured,
      featuresNote: cfg.configured ? 'See asc_settings for the feature switches.' : 'Feature switches are at their defaults. The owner can choose them with /hypercaffium-apple:setup.',
      writesNote: cfg.writesEnabled
        ? 'Writes are ON: changes need asc_prepare_change then asc_apply_change.'
        : 'Writes are OFF (kill switch). Previews still work. Set "writesEnabled": true in the config file to allow changes.',
    };
  },
);

readTool('asc_list_apps', 'List the apps in the App Store Connect account (name, bundle ID, SKU).', {}, async () =>
  flattenList(await ascGet('/v1/apps', { limit: 50 })),
);

readTool(
  'asc_release_status',
  'One-call answer to "where is my iOS app?": what is live (with phased-release progress), which versions are in flight (in review, waiting, rejected, preparing), and the latest builds with processing state. Times are shown in the configured local time zone. If appId is omitted and the account has exactly one app, that app is used.',
  { appId: z.string().optional().describe('Numeric App Store Connect app ID (optional if the account has one app)') },
  async ({ appId }) => {
    let id = appId;
    if (!id) {
      const apps = flattenList(await ascGet('/v1/apps', { limit: 50 }));
      if (apps.length !== 1) {
        throw new Error(`Account has ${apps.length} apps; pass appId. Options: ${apps.map((a) => `${a.name}=${a.id}`).join(', ')}`);
      }
      id = apps[0].id;
    }
    const enc = encodeURIComponent(id);
    const [appBody, versionsBody, buildsBody] = await Promise.all([
      ascGet(`/v1/apps/${enc}`),
      ascGet(`/v1/apps/${enc}/appStoreVersions`, { limit: 20 }),
      ascGet('/v1/builds', { 'filter[app]': id, sort: '-uploadedDate', limit: 3 }),
    ]);
    const versions = flattenList(versionsBody);
    const live = [...versions]
      .sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)))
      .find((v) => (v.appStoreState || v.appVersionState) === 'READY_FOR_SALE');
    let phased = null;
    if (live) {
      try {
        const p = await ascGet(`/v1/appStoreVersions/${encodeURIComponent(live.id)}/appStoreVersionPhasedRelease`);
        phased = p.data ? flatten(p.data) : null;
      } catch {
        phased = null; // no phased release configured for this version
      }
    }
    return buildAppleStatus({
      app: flatten(appBody.data),
      versions,
      builds: flattenList(buildsBody),
      phased,
    });
  },
);

readTool(
  'asc_list_versions',
  'List App Store versions of an app with their state (e.g. READY_FOR_SALE, WAITING_FOR_REVIEW, IN_REVIEW, REJECTED, PREPARE_FOR_SUBMISSION). Use this to check review status and what is live.',
  { appId: z.string().describe('The numeric App Store Connect app ID from asc_list_apps') },
  async ({ appId }) => flattenList(await ascGet(`/v1/apps/${encodeURIComponent(appId)}/appStoreVersions`, { limit: 20 })),
);

readTool(
  'asc_list_builds',
  'List uploaded builds of an app, newest first, with processing state and expiry. Use this to see whether a build finished processing for TestFlight.',
  {
    appId: z.string().describe('The numeric App Store Connect app ID'),
    limit: z.number().int().min(1).max(50).default(10).describe('How many builds to return'),
  },
  async ({ appId, limit }) =>
    flattenList(await ascGet('/v1/builds', { 'filter[app]': appId, sort: '-uploadedDate', limit })),
);

readTool(
  'asc_list_beta_groups',
  'List TestFlight beta groups for an app.',
  { appId: z.string().describe('The numeric App Store Connect app ID') },
  async ({ appId }) => flattenList(await ascGet(`/v1/apps/${encodeURIComponent(appId)}/betaGroups`, { limit: 50 })),
);

readTool(
  'asc_list_customer_reviews',
  'List App Store customer reviews for an app, newest first (rating, title, body, reviewer nickname, territory).',
  {
    appId: z.string().describe('The numeric App Store Connect app ID'),
    limit: z.number().int().min(1).max(100).default(20).describe('How many reviews to return'),
  },
  async ({ appId, limit }) =>
    flattenList(await ascGet(`/v1/apps/${encodeURIComponent(appId)}/customerReviews`, { sort: '-createdDate', limit })),
);

// ---- full API coverage via the bundled official spec ------------------------

readTool(
  'asc_search_api',
  "Search Apple's full App Store Connect API (1,300+ operations) by keyword. Returns matching operations with their operationId, method and path. Follow with asc_describe_operation, then asc_call. Example queries: 'screenshots', 'phased release', 'beta testers', 'subscription prices'.",
  {
    query: z.string().describe('Keywords, all of which must match the operation name, path or area'),
    method: z.enum(['GET', 'POST', 'PATCH', 'DELETE']).optional().describe('Optionally filter by HTTP method'),
    limit: z.number().int().min(1).max(50).default(15).describe('Maximum results'),
  },
  async ({ query, method, limit }) => {
    const { specVersion } = loadSpec();
    return { specVersion, results: searchOperations({ query, method, limit }) };
  },
);

readTool(
  'asc_describe_operation',
  'Show exactly how to call one API operation: its method, path, required path parameters, and the query parameters it accepts (filters, sort, include, limit, with allowed values).',
  { operationId: z.string().describe('An operationId from asc_search_api') },
  async ({ operationId }) => {
    const op = getOperation(operationId);
    if (!op) throw new Error(`Unknown operationId "${operationId}". Use asc_search_api to find one.`);
    const pathParams = op.params.filter((p) => p.in === 'path').map((p) => p.name);
    const query = op.params.filter((p) => p.in === 'query');
    return {
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      area: op.tag,
      canCallNow: op.method === 'GET',
      note:
        op.method === 'GET'
          ? undefined
          : 'This operation changes data. Do not call it with asc_call. Use asc_prepare_change (preview + ticket), then asc_apply_change after the owner confirms.',
      requiresRequestBody: Boolean(op.hasBody),
      bodyShape: op.body,
      pathParams,
      queryParams: query.map(({ in: _in, ...rest }) => rest),
    };
  },
);

readTool(
  'asc_call',
  'Call any App Store Connect API READ operation (GET) by operationId. Operations that would change data are refused here; use asc_prepare_change for those. Results are flattened; use nextPage with asc_next_page for more.',
  {
    operationId: z.string().describe('An operationId from asc_search_api'),
    pathParams: z.record(z.string(), z.string()).optional().describe('Values for {placeholders} in the path, e.g. {"id":"123"}'),
    query: z.record(z.string(), z.string()).optional().describe('Query parameters, e.g. {"limit":"10","filter[platform]":"IOS"}'),
  },
  async ({ operationId, pathParams, query }) => {
    const op = getOperation(operationId);
    if (!op) throw new Error(`Unknown operationId "${operationId}". Use asc_search_api to find one.`);
    if (op.method !== 'GET') {
      throw new Error(
        `${op.operationId} is a ${op.method} operation that changes data, so asc_call will not run it. Use asc_prepare_change to get a preview and a ticket, then asc_apply_change after the owner confirms.`,
      );
    }
    const body = await ascGet(fillPath(op.path, pathParams), query || {});
    return simplify(body);
  },
);

readTool(
  'asc_next_page',
  'Fetch the next page of a previous asc_call result, using its nextPage link.',
  { url: z.string().describe('The nextPage URL returned by a previous call') },
  async ({ url }) => {
    const u = new URL(url);
    if (u.origin !== API_ORIGIN || !/^\/v[123]\//.test(u.pathname)) {
      throw new Error('That URL is not an App Store Connect API page link.');
    }
    return simplify(await ascGetUrl(u));
  },
);

readTool(
  'asc_api_get',
  'Read-only escape hatch: perform a GET against any App Store Connect API path (must start with /v1/, /v2/ or /v3/). Prefer asc_search_api + asc_call.',
  {
    path: z.string().describe('API path, e.g. /v1/apps/123456789/appInfos'),
    query: z.record(z.string(), z.string()).optional().describe('Optional query-string parameters'),
  },
  async ({ path: p, query }) => {
    if (!/^\/v[123]\/[A-Za-z0-9_\-/]*$/.test(p)) {
      throw new Error('path must look like /v1/apps/123 (letters, digits, dashes, underscores and slashes only)');
    }
    return simplify(await ascGet(p, query || {}));
  },
);

// ---- guarded writes: prepare (preview) then apply (execute that exact ticket) ----

readTool(
  'asc_prepare_change',
  'STEP 1 of changing anything in App Store Connect. Describes the exact change, shows the current value next to the new one, assigns a safety tier (1 low-risk, 2 needs the owner\'s confirmation, 3 blocked), and returns a one-time ticket valid for 10 minutes. Changes NOTHING. Show the preview to the owner in plain English before applying.',
  {
    operationId: z.string().describe('A write operationId from asc_search_api (POST or PATCH)'),
    pathParams: z.record(z.string(), z.string()).optional().describe('Values for {placeholders} in the path, e.g. {"id":"123"}'),
    query: z.record(z.string(), z.string()).optional().describe('Optional query parameters'),
    body: z.record(z.string(), z.unknown()).optional().describe('JSON:API request body, e.g. {"data":{"type":"...","id":"...","attributes":{...}}}'),
  },
  async ({ operationId, pathParams, query, body }) => {
    const op = getOperation(operationId);
    if (!op) throw new Error(`Unknown operationId "${operationId}". Use asc_search_api to find one.`);
    const preview = await prepareChange({ op, pathParams, query, body, deps: writeDeps });
    audit(PLUGIN, {
      tool: 'asc_prepare_change',
      kind: 'prepare',
      operation: preview.operation,
      tier: preview.tier,
      allowed: preview.allowed,
      ticket: preview.ticket,
    });
    return { ...preview, writesEnabled: loadConfig().writesEnabled };
  },
);

function registerApply(name, description, requireTier1, annotations, sensitiveTool = false) {
  server.registerTool(
    name,
    { description, inputSchema: { ticket: z.string().describe('The ticket from asc_prepare_change') }, annotations },
    async ({ ticket }) => {
      const started = Date.now();
      try {
        const out = await applyChange({ ticketId: ticket, requireTier1, sensitiveTool, deps: writeDeps });
        audit(PLUGIN, {
          tool: name,
          kind: 'write',
          ok: true,
          ms: Date.now() - started,
          ticket,
          operation: out.operation,
          title: out.title,
          stepsDone: out.completed?.length ?? out.results?.length,
          partialFailure: out.applied === false ? true : undefined,
          tier: out.tier,
          sensitive: sensitiveTool || undefined,
          beforeJson: JSON.stringify(out.before ?? null).slice(0, 4000),
          afterJson: JSON.stringify(out.result ?? null).slice(0, 4000),
        });
        return ok({ ...out, result: out.result?.data ? simplify(out.result) : out.result });
      } catch (err) {
        audit(PLUGIN, { tool: name, kind: 'write', ok: false, ms: Date.now() - started, ticket, error: String(err.message || err) });
        return fail(err);
      }
    },
  );
}

registerApply(
  'asc_apply_change',
  'STEP 2 of changing anything in App Store Connect: executes EXACTLY the change previewed by asc_prepare_change, once. Only call this after the owner has explicitly said yes to the preview. Refused if writes are switched off, the ticket is unknown/expired/used, or the situation changed since the preview.',
  false,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
);

registerApply(
  'asc_apply_safe_change',
  'Like asc_apply_change, but ONLY accepts Tier 1 (low-risk, non-live) tickets, so it can be allowed to run without a prompt. Refuses anything that needs the owner\'s confirmation.',
  true,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
);

registerApply(
  'asc_apply_sensitive_change',
  'Applies ONLY critical changes (users and permissions, signing assets), and only ones previewed by a prepare tool that said to use this tool. It is separate from asc_apply_change so that allowing that tool can never cover a critical change. Only call this after the owner has read the preview and explicitly said yes.',
  false,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  true,
);

// ---- settings (the in-chat part of /hypercaffium-apple:setup) ----------------------

function settingsView() {
  const cfg = loadConfig();
  return {
    settingsFile: CONFIG_PATH,
    configured: cfg.configured,
    credentialsProblems: configProblems(cfg),
    writesEnabled: cfg.writesEnabled,
    features: describeFeatures(currentFeatures(), 'apple'),
    toolsLoadedFor: Object.keys(STARTUP_FEATURES).filter((k) => STARTUP_FEATURES[k]),
    criticalSettings: `Critical features can only be switched ON in the terminal menu. Open a terminal window (not this chat) and run: node "${SETUP_SCRIPT}"`,
    restartNote: 'After changing features, restart Claude Code so the dedicated tools match. Switching a feature off takes effect immediately either way.',
  };
}

readTool(
  'asc_settings',
  "Show this plugin's settings: whether credentials are set up, the writes master switch, and every feature switch grouped by risk level (low, medium, high, critical) with what it covers. Read-only.",
  {},
  async () => settingsView(),
);

server.registerTool(
  'asc_save_settings',
  {
    description:
      "Save this plugin's settings file (used by /hypercaffium-apple:setup). Only change what the owner chose in this conversation. Critical features (users, signing) can be switched OFF here but never ON: that needs the terminal menu. Writes the JSON file safely (paths are escaped for you).",
    inputSchema: {
      keyId: z.string().regex(/^[A-Z0-9]{10}$/).optional().describe('10-character Key ID'),
      issuerId: z.string().uuid().optional().describe('Issuer ID (a UUID)'),
      keyPath: z.string().optional().describe('Full path to the AuthKey_XXXXXXXXXX.p8 file'),
      timezone: z.string().optional().describe('IANA time zone such as America/New_York'),
      writesEnabled: z.boolean().optional().describe('Master switch for all changes'),
      features: z.record(z.string(), z.boolean()).optional().describe('Feature switches to change, e.g. {"uploads": false}'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      if (args.keyPath && !/\.p8$/i.test(args.keyPath)) throw new Error('keyPath must point to the .p8 key file.');
      if (args.timezone) new Intl.DateTimeFormat('en-US', { timeZone: args.timezone });
      const turnedOnCritical = Object.entries(args.features || {}).filter(([k, v]) => v && isCritical(k) && !currentFeatures()[k]);
      if (turnedOnCritical.length) {
        throw new Error(`${turnedOnCritical.map(([k]) => k).join(', ')} can only be switched on in the terminal menu: open a terminal window and run node "${SETUP_SCRIPT}"`);
      }
      saveSettings(CONFIG_PATH, args, 'apple');
      audit(PLUGIN, { tool: 'asc_save_settings', kind: 'settings', ok: true, changed: Object.keys(args) });
      return ok({ saved: true, ...settingsView() });
    } catch (err) {
      audit(PLUGIN, { tool: 'asc_save_settings', kind: 'settings', ok: false, error: String(err.message || err) });
      return fail(err);
    }
  },
);

// ---- release workflows (previews + tickets; nothing changes until an apply tool runs) ----

const appId = z.string().optional().describe('Numeric App Store Connect app ID (optional if the account has one app)');
const versionArg = z.string().optional().describe('Version string like 1.1.4 (default: the editable draft version)');

readTool(
  'asc_release_overview',
  'Everything about one App Store release in a single answer: version state, attached build, per-locale text and release notes, screenshots, App Review details, phased release, any open submission, and a PRE-FLIGHT checklist saying whether it is ready to submit and what blocks it. Read-only.',
  { appId, version: versionArg },
  (a) => releaseOverview(writeDeps, a),
);

featureTool('listing',
  'asc_edit_listing',
  'Prepare an edit to a draft version\'s App Store text for one locale: description, keywords, whatsNew (release notes), promotionalText, marketingUrl, supportUrl. Returns a preview with before/after and a ticket. Tier 1 on a draft. Creates the locale if it does not exist.',
  {
    appId,
    version: versionArg,
    locale: z.string().default('en-US').describe('Locale such as en-US'),
    description: z.string().optional(),
    keywords: z.string().optional().describe('Comma-separated, 100 characters max'),
    whatsNew: z.string().optional().describe('Release notes, 4000 characters max'),
    promotionalText: z.string().optional().describe('170 characters max'),
    marketingUrl: z.string().optional(),
    supportUrl: z.string().optional(),
  },
  ({ appId: a, version, locale, ...fields }) => prepareListingEdit(writeDeps, { appId: a, version, locale, fields }),
);

featureTool('listing',
  'asc_set_release_notes',
  'Prepare saving the release notes ("What\'s New") for a draft version in one locale. Shows the old and new text and returns a ticket (Tier 1 on a draft).',
  { appId, version: versionArg, locale: z.string().default('en-US'), whatsNew: z.string().describe('The release notes text') },
  ({ appId: a, version, locale, whatsNew }) => prepareListingEdit(writeDeps, { appId: a, version, locale, fields: { whatsNew } }),
);

featureTool('releases',
  'asc_attach_build',
  'Prepare choosing which processed build a draft version will ship (the build EAS uploaded). Checks the build exists, is VALID and not expired. Tier 1 on a draft.',
  { appId, version: versionArg, buildNumber: z.string().describe('Build number, e.g. "57"') },
  (a) => prepareAttachBuild(writeDeps, a),
);

featureTool('releases',
  'asc_create_version',
  'Prepare creating a new draft App Store version (e.g. 1.1.4). Refuses if that version exists or another draft is already open. Tier 1 (a draft is invisible to users).',
  {
    appId,
    versionString: z.string().describe('New version, e.g. 1.1.4'),
    releaseType: z.enum(['AFTER_APPROVAL', 'MANUAL', 'SCHEDULED']).default('AFTER_APPROVAL'),
  },
  (a) => prepareCreateVersion(writeDeps, a),
);

featureTool('releases',
  'asc_submit_for_review',
  'Prepare submitting a draft version to App Review. Runs the pre-flight checklist first and returns the problems (with NO ticket) if anything blocks it. Otherwise returns a 3-step plan and a ticket (Tier 2). States plainly whether the version will release automatically after approval.',
  { appId, version: versionArg },
  (a) => prepareSubmit(writeDeps, a),
);

featureTool('releases',
  'asc_cancel_submission',
  'Prepare cancelling the open App Review submission (pulls the version back to editable). Tier 2.',
  { appId },
  (a) => prepareCancelSubmission(writeDeps, a),
);

featureTool('releases',
  'asc_phased_release',
  'Prepare a phased-release action for a version: enable (before release), pause, resume, or complete (release to everyone now). Tier 2.',
  { appId, version: versionArg, action: z.enum(['enable', 'pause', 'resume', 'complete']) },
  (a) => preparePhasedRelease(writeDeps, a),
);

featureTool('releases',
  'asc_release_version',
  'Prepare releasing an APPROVED version that is waiting for you (PENDING_DEVELOPER_RELEASE) to the App Store. Tier 2.',
  { appId, version: versionArg },
  (a) => prepareReleaseNow(writeDeps, a),
);

featureTool('listing',
  'asc_upload_screenshots',
  'Prepare uploading PNG/JPEG screenshots from local files to a DRAFT version for one locale and display type (e.g. APP_IPHONE_67). Adds only; never deletes. Returns a ticket (Tier 1). Applying uploads the files and waits for Apple to process them.',
  {
    appId,
    version: versionArg,
    locale: z.string().default('en-US'),
    displayType: z.string().describe('Apple display type, e.g. APP_IPHONE_67, APP_IPAD_PRO_3GEN_129'),
    files: z.array(z.string()).min(1).max(10).describe('Full paths to the image files, in the order they should appear'),
  },
  (a) => prepareScreenshots(writeDeps, a),
);

featureTool('listing',
  'asc_clear_screenshots',
  "Prepare REMOVING screenshots of one display type and locale from a DRAFT version (so new ones can be uploaded). This is the only delete the plugin allows, and only for a draft. Tier 2: needs the owner's explicit yes. keepFirst keeps that many from the start of the set.",
  {
    appId,
    version: versionArg,
    locale: z.string().default('en-US'),
    displayType: z.string().describe('Apple display type, e.g. APP_IPHONE_67'),
    keepFirst: z.number().int().min(0).default(0).describe('How many screenshots to keep from the start of the set'),
  },
  (a) => prepareClearScreenshots(writeDeps, a),
);

// ---- subscriptions -----------------------------------------------------------

const subscriptionId = z.string().describe('Subscription ID from asc_subscription_overview');

readTool(
  'asc_subscription_overview',
  'All subscription groups and subscriptions for the app: name, product ID, state, period, localizations, offer counts, current US price and any scheduled price changes. Read-only.',
  { appId },
  (a) => subscriptionOverview(writeDeps, a),
);

readTool(
  'asc_subscription_prices',
  'Current and scheduled prices of one subscription per territory (price, currency, proceeds, start date). Read-only.',
  { subscriptionId, territory: z.string().optional().describe('Territory code such as USA (default: all)') },
  (a) => subscriptionPrices(writeDeps, a),
);

readTool(
  'asc_find_price_point',
  'Look up Apple\'s allowed price points for a subscription in one territory, optionally matching an exact amount (or showing the nearest). Read-only.',
  { subscriptionId, territory: z.string().default('USA'), amount: z.number().optional() },
  (a) => findPricePoint(writeDeps, a),
);

featureTool('pricing',
  'asc_set_subscription_price',
  'Prepare a subscription price change. Previews every territory old-to-new with currency and percentage, and whether existing subscribers keep their price. Tier 2 ALWAYS; never automatic. allTerritories sets Apple\'s equalized price in every territory.',
  {
    subscriptionId,
    territory: z.string().default('USA').describe('Base territory the amount is in'),
    amount: z.number().optional().describe('Price in the base territory, e.g. 4.99 (must be one of Apple\'s price points)'),
    pricePointId: z.string().optional().describe('Alternative to amount'),
    allTerritories: z.boolean().default(false).describe('Also set the equalized price in every other territory'),
    startDate: z.string().optional().describe('YYYY-MM-DD; omit to start immediately'),
    preserveCurrentPrice: z.boolean().default(true).describe('true = existing subscribers keep their current price'),
  },
  (a) => prepareSetPrice(writeDeps, a),
);

featureTool('pricing',
  'asc_edit_subscription',
  'Prepare editing a subscription\'s name, review note, family sharing or group level. Tier 2.',
  {
    subscriptionId,
    name: z.string().optional(),
    reviewNote: z.string().optional(),
    familySharable: z.boolean().optional(),
    groupLevel: z.number().int().optional(),
  },
  ({ subscriptionId: id, ...fields }) => prepareEditSubscription(writeDeps, { subscriptionId: id, fields }),
);

featureTool('pricing',
  'asc_edit_subscription_localization',
  'Prepare editing (or creating) a subscription\'s display name and description for one locale. Name 2-30 characters, description up to 45. Tier 2.',
  { subscriptionId, locale: z.string(), name: z.string().optional(), description: z.string().optional() },
  (a) => prepareEditSubscriptionLocalization(writeDeps, a),
);

featureTool('pricing',
  'asc_create_intro_offer',
  'Prepare an introductory offer (free trial, pay-as-you-go, or pay-up-front) on a subscription. Tier 2. For promotional offers, offer codes and win-back offers use asc_search_api + asc_prepare_change.',
  {
    subscriptionId,
    offerMode: z.enum(['FREE_TRIAL', 'PAY_AS_YOU_GO', 'PAY_UP_FRONT']).default('FREE_TRIAL'),
    duration: z.enum(['THREE_DAYS', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR']).default('ONE_WEEK'),
    numberOfPeriods: z.number().int().min(1).default(1),
    territory: z.string().optional().describe('Omit for all territories'),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    amount: z.number().optional().describe('Price per period (paid offers only; needs territory)'),
  },
  (a) => prepareIntroOffer(writeDeps, a),
);

// ---- reviews, App Review details, app info, TestFlight -----------------------------

readTool(
  "asc_review_inbox",
  "App Store customer reviews with a replied/unreplied flag, newest first. By default only reviews that still need a reply. Read-only. Use asc_reply_to_review to answer one.",
  {
    appId,
    limit: z.number().int().min(1).max(100).default(20).describe("How many reviews to return"),
    unrepliedOnly: z.boolean().default(true).describe("Only reviews without a developer reply"),
  },
  (a) => reviewInbox(writeDeps, a),
);

featureTool('reviews',
  "asc_reply_to_review",
  "Prepare a PUBLIC reply to an App Store review (visible to everyone). Shows the review, any existing reply that would be replaced, and returns a ticket (Tier 2, needs the owner's explicit yes).",
  { reviewId: z.string().describe("Review id from asc_review_inbox"), text: z.string().describe("The reply, 5970 characters max") },
  (a) => prepareReplyToReview(writeDeps, a),
);

featureTool('listing',
  "asc_edit_review_details",
  "Prepare editing the App Review details of a draft version: contact name, phone, email, whether a demo account is required and its login, and notes for the reviewer. The demo password is never shown in previews or the audit log. Tier 1 on a draft.",
  {
    appId,
    version: versionArg,
    contactFirstName: z.string().optional(),
    contactLastName: z.string().optional(),
    contactPhone: z.string().optional().describe("Like +15551234567"),
    contactEmail: z.string().optional(),
    demoAccountRequired: z.boolean().optional(),
    demoAccountName: z.string().optional(),
    demoAccountPassword: z.string().optional(),
    notes: z.string().optional().describe("Notes for the App Review team, 4000 characters max"),
  },
  ({ appId: a, version, ...fields }) => prepareReviewDetails(writeDeps, { appId: a, version, fields }),
);

featureTool('listing',
  "asc_edit_app_info",
  "Prepare editing the app name, subtitle, privacy policy URL, privacy choices URL or privacy policy text for one locale. Only possible while a version is being prepared. Name and subtitle become public on release, so this is Tier 2.",
  {
    appId,
    locale: z.string().default("en-US"),
    name: z.string().optional().describe("30 characters max"),
    subtitle: z.string().optional().describe("30 characters max"),
    privacyPolicyUrl: z.string().optional(),
    privacyChoicesUrl: z.string().optional(),
    privacyPolicyText: z.string().optional(),
  },
  ({ appId: a, locale, ...fields }) => prepareAppInfo(writeDeps, { appId: a, locale, fields }),
);

readTool(
  "asc_testflight_overview",
  "TestFlight at a glance: each group (internal or external), its public link, tester count and recent builds. Read-only.",
  { appId },
  (a) => testflightOverview(writeDeps, a),
);

featureTool('testing',
  "asc_testflight_set_notes",
  "Prepare the TestFlight What to test notes for a build and locale (creates them if missing). Tier 1: testers only, easy to edit back.",
  { appId, buildNumber: z.string().describe("Build number, e.g. 57"), locale: z.string().default("en-US"), whatsNew: z.string() },
  (a) => prepareTestflightNotes(writeDeps, a),
);

featureTool('testing',
  "asc_testflight_add_tester",
  "Prepare adding a tester to a TestFlight group (external groups: Apple emails an invitation). Reuses the person if they already exist. Tier 2.",
  {
    appId,
    email: z.string(),
    group: z.string().describe("TestFlight group name or id from asc_testflight_overview"),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  },
  (a) => prepareAddTester(writeDeps, a),
);

featureTool('testing',
  "asc_testflight_add_build_to_group",
  "Prepare making a processed build available to a TestFlight group. External groups need Apple's beta review for a new build. Tier 2.",
  { appId, buildNumber: z.string(), group: z.string().describe("TestFlight group name or id") },
  (a) => prepareAddBuildToGroup(writeDeps, a),
);

// ---- generic multi-step plans, and monitoring ---------------------------------

readTool(
  'asc_prepare_plan',
  'Power tool: prepare SEVERAL dependent changes approved once and run in order. Each step names an API method + path template and may reference earlier results as {{0.id}} (step 0\'s created ID) or {{0.attributeName}}. Returns a preview of every step and one ticket. Prefer the dedicated workflow tools when one fits.',
  {
    title: z.string().describe('Plain-English description of the whole plan'),
    steps: z
      .array(
        z.object({
          label: z.string(),
          method: z.enum(['POST', 'PATCH']),
          path: z.string().describe('Path template, e.g. /v1/reviewSubmissions/{id}'),
          pathParams: z.record(z.string(), z.string()).optional(),
          query: z.record(z.string(), z.string()).optional(),
          body: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .min(1)
      .max(250),
  },
  (a) => preparePlan({ ...a, deps: writeDeps }),
);

readTool(
  'asc_check_changes',
  'What changed in App Store Connect since the last check: version and build state changes, review-submission progress, new customer reviews. The first call saves a baseline. Run it periodically (for example with /loop or a scheduled routine) to be told about changes.',
  { appId },
  (a) => appleCheckChanges(writeDeps, a),
);

readTool(
  'asc_audit_log',
  'Show the most recent entries of this plugin\'s activity log (which tools ran, with what arguments, success or failure). The log file lives in ~/.claude-plugins/audit/.',
  { limit: z.number().int().min(1).max(100).default(20).describe('How many entries (newest first)') },
  async ({ limit }) =>
    readAudit(PLUGIN, limit).map((e) => ({ ...e, whenLocal: toLocalTime(e.ts) })),
);

await server.connect(new StdioServerTransport());
