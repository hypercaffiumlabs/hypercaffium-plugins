#!/usr/bin/env node
// Google Play Console MCP server. PHASE 2b: FULL API COVERAGE + GUARDED WRITES.
// Reads are plain GETs (tracks/bundles need a temporary, empty "edit" that is always deleted;
// guard.js makes committing impossible on that path). Changes only happen through a two-step
// flow: play_prepare_change (preview + one-time ticket) then play_apply_change /
// play_apply_safe_change (executes exactly that ticket), and only when the kill switch
// ("writesEnabled") is on. Everything is recorded in the audit log.
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { audit, readAudit } from './audit.js';
import { CONFIG_PATH, configProblems, getAccessToken, loadConfig } from './auth.js';
import { API_ORIGIN, APP_BASE, playRequest, withTemporaryEdit } from './client.js';
import { assertWriteAllowed } from './guard.js';
import { fillPath, getMethod, loadSpec, searchMethods, splitParams } from './spec.js';
import { buildPlayStatus } from './status.js';
import { limitText, toLocalTime } from './util.js';
import { applyChange, prepareChange, TicketStore } from './writes.js';
import { currentFeatures, setFeatureSource } from './rules.js';
import { describeFeatures, isCritical, saveSettings } from '../../shared/features.js';
import { googleCheckChanges } from './monitor.js';
import { prepareEditListing, prepareReplyToReview } from './listing.js';
import { prepareReplaceImages, prepareUploadImages, runImages } from './images.js';
import { subscriptionOverview } from './subscriptions.js';
import { prepareMigratePrices, prepareSetSubscriptionPrice } from './pricing.js';
import { listTesters, prepareSetTesters } from './testers.js';
import { prepareUploadBundle, runBundle } from './bundles.js';
import { prepareReleaseNotes, preparePromote, prepareRollout, prepareSetRelease } from './release.js';

const PLUGIN = 'google-play-console';

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
const SETUP_SCRIPT = /[\\/]dist[\\/][^\\/]+$/.test(fileURLToPath(import.meta.url))
  ? fileURLToPath(new URL('./setup.mjs', import.meta.url))
  : fileURLToPath(new URL('./dist/setup.mjs', import.meta.url));

// The ONLY function in this server that can change anything. It is referenced solely by the
// apply path (writeDeps.send below), after a valid, unexpired, single-use ticket has been checked,
// and assertWriteAllowed() independently restricts what it may touch.
async function playSend(method, pathname, query = {}, body) {
  assertWriteAllowed(method, pathname);
  const url = new URL(pathname, API_ORIGIN);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers = { Authorization: `Bearer ${await getAccessToken()}`, Accept: 'application/json' };
  const init = { method, headers };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return { status: 204 };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(`Google Play API ${res.status} for ${method} ${url.pathname}: ${e.message || e.status || 'unknown error'}`);
  }
  return json;
}

const ticketStore = new TicketStore();
const writeDeps = {
  store: ticketStore,
  get: (p, q) => playRequest('GET', p, q),
  send: playSend,
  defaultPackage: () => loadConfig().defaultPackageName,
  writesEnabled: () => loadConfig().writesEnabled,
  // Reads for the "before" picture; opens a throwaway edit only when needed.
  withReadContext: (pkg, needsEdit, fn) => (needsEdit ? withTemporaryEdit(pkg, fn) : fn(null)),
  // Google's price converter: calculates local prices, changes nothing (allowed by the read guard).
  convert: (pkg, body) => playRequest('POST', `${APP_BASE}/${pkg}/pricing:convertRegionPrices`, {}, body),
};

// Listing images go through Google's media-upload endpoint, only after a valid ticket (see runImages).
async function playUpload({ pkg, editId, language, imageType, bytes, mime }) {
  const pathname = `/upload${APP_BASE}/${pkg}/edits/${editId}/listings/${language}/${imageType}`;
  assertWriteAllowed('POST', pathname);
  const url = new URL(pathname, API_ORIGIN);
  url.searchParams.set('uploadType', 'media');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': mime, Accept: 'application/json' },
    body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(`Google Play image upload failed (${res.status}): ${e.message || e.status || 'unknown error'}`);
  }
  return json;
}
writeDeps.upload = playUpload;
writeDeps.runImages = (payload) => runImages(payload, writeDeps);

// App bundle and mapping uploads (Google's media-upload endpoint), only after a valid ticket.
async function playUploadBinary(pathname, bytes) {
  assertWriteAllowed('POST', pathname);
  const url = new URL(pathname, API_ORIGIN);
  url.searchParams.set('uploadType', 'media');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/octet-stream', Accept: 'application/json' },
    body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(`Google Play upload failed (${res.status}): ${e.message || e.status || 'unknown error'}`);
  }
  return json;
}
writeDeps.uploadBundle = ({ pkg, editId, bytes }) => playUploadBinary(`/upload${APP_BASE}/${pkg}/edits/${editId}/bundles`, bytes);
writeDeps.uploadMapping = ({ pkg, editId, versionCode, bytes }) =>
  playUploadBinary(`/upload${APP_BASE}/${pkg}/edits/${editId}/apks/${versionCode}/deobfuscationFiles/proguard`, bytes);
writeDeps.runBundle = (payload) => runBundle(payload, writeDeps);

function resolvePackage(arg) {
  const pkg = arg || loadConfig().defaultPackageName;
  if (!pkg) {
    throw new Error(`No package name given and no defaultPackageName in ${CONFIG_PATH}. Pass packageName, e.g. com.example.app.`);
  }
  if (!/^[A-Za-z0-9._]+$/.test(pkg)) throw new Error(`"${pkg}" does not look like an Android package name.`);
  return pkg;
}

const ok = (value) => ({ content: [{ type: 'text', text: limitText(JSON.stringify(value, null, 2)) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const packageName = z
  .string()
  .optional()
  .describe('Android package name, e.g. com.example.app. Defaults to defaultPackageName from the config file.');

const server = new McpServer({ name: 'hypercaffium-play', version: '0.12.2' });

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
  'play_check_setup',
  'Check whether Google Play credentials are configured and accepted. Run this first if any other play_ tool fails.',
  { packageName },
  async ({ packageName: p }) => {
    const cfg = loadConfig();
    const problems = configProblems(cfg);
    if (problems.length) return { configured: false, configFile: CONFIG_PATH, problems };
    const pkg = resolvePackage(p);
    const details = await withTemporaryEdit(pkg, (editId) => playRequest('GET', `${APP_BASE}/${pkg}/edits/${editId}/details`));
    return {
      configured: true,
      apiAccepted: true,
      packageName: pkg,
      appDetails: details,
      writesEnabled: cfg.writesEnabled,
      featuresChosen: cfg.configured,
      featuresNote: cfg.configured ? 'See play_settings for the feature switches.' : 'Feature switches are at their defaults. The owner can choose them with /hypercaffium-play:setup.',
      writesNote: cfg.writesEnabled
        ? 'Writes are ON: changes need play_prepare_change then play_apply_change.'
        : 'Writes are OFF (kill switch). Previews still work. Set "writesEnabled": true in the config file to allow changes.',
    };
  },
);

readTool(
  'play_release_status',
  'One-call answer to "where is my Android app?": what is live in production, any staged rollout in progress (with percentage), halted or draft releases, the other tracks (internal, alpha, beta), and the newest uploaded version code.',
  { packageName },
  async ({ packageName: p }) => {
    const pkg = resolvePackage(p);
    const { tracks, bundles, details } = await withTemporaryEdit(pkg, async (editId) => {
      const base = `${APP_BASE}/${pkg}/edits/${editId}`;
      const [t, b, d] = await Promise.all([
        playRequest('GET', `${base}/tracks`),
        playRequest('GET', `${base}/bundles`),
        playRequest('GET', `${base}/details`).catch(() => null),
      ]);
      return { tracks: t.tracks || [], bundles: b.bundles || [], details: d };
    });
    return buildPlayStatus({ packageName: pkg, tracks, bundles, details });
  },
);

readTool(
  'play_list_tracks',
  'List release tracks (internal, alpha, beta, production) with each release: version codes, status (draft, inProgress, completed, halted) and staged-rollout fraction. Use this to see what is live and at what rollout percentage.',
  { packageName },
  async ({ packageName: p }) => {
    const pkg = resolvePackage(p);
    const body = await withTemporaryEdit(pkg, (editId) => playRequest('GET', `${APP_BASE}/${pkg}/edits/${editId}/tracks`));
    return (body.tracks || []).map((t) => ({
      track: t.track,
      releases: (t.releases || []).map((r) => ({
        name: r.name,
        status: r.status,
        versionCodes: r.versionCodes,
        userFraction: r.userFraction,
        releaseNotes: (r.releaseNotes || []).map((n) => ({ language: n.language, text: n.text })),
      })),
    }));
  },
);

readTool(
  'play_list_bundles',
  'List the app bundles (.aab) already uploaded to the app, with version codes.',
  { packageName },
  async ({ packageName: p }) => {
    const pkg = resolvePackage(p);
    const body = await withTemporaryEdit(pkg, (editId) => playRequest('GET', `${APP_BASE}/${pkg}/edits/${editId}/bundles`));
    return body.bundles || [];
  },
);

readTool(
  'play_list_reviews',
  'List recent Google Play user reviews (the API only returns reviews from roughly the last week). Each has star rating, text, app version and last-modified time in local time.',
  {
    packageName,
    maxResults: z.number().int().min(1).max(100).default(20).describe('How many reviews to return'),
  },
  async ({ packageName: p, maxResults }) => {
    const pkg = resolvePackage(p);
    const body = await playRequest('GET', `${APP_BASE}/${pkg}/reviews`, { maxResults });
    return (body.reviews || []).map((r) => {
      const u = r.comments?.find((c) => c.userComment)?.userComment || {};
      const dev = r.comments?.find((c) => c.developerComment)?.developerComment;
      return {
        reviewId: r.reviewId,
        author: r.authorName,
        stars: u.starRating,
        text: u.text,
        appVersionName: u.appVersionName,
        lastModifiedLocal: toLocalTime(u.lastModified),
        developerReply: dev?.text,
      };
    });
  },
);

// ---- full API coverage via the bundled official description -----------------

readTool(
  'play_search_api',
  "Search Google's full Play Developer API (145 methods) by keyword. Returns matching methods with methodId, HTTP method and path. Follow with play_describe_method, then play_call. Example queries: 'listings', 'tracks', 'subscriptions', 'reviews', 'users'.",
  {
    query: z.string().describe('Keywords, all of which must match the method id or path'),
    httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('Optionally filter by HTTP method'),
    limit: z.number().int().min(1).max(50).default(15).describe('Maximum results'),
  },
  async ({ query, httpMethod, limit }) => {
    const { specRevision } = loadSpec();
    return { specRevision, results: searchMethods({ query, httpMethod, limit }) };
  },
);

readTool(
  'play_describe_method',
  'Show exactly how to call one API method: HTTP method, path, which parameters are required, and the optional query parameters with allowed values.',
  { methodId: z.string().describe('A methodId from play_search_api, e.g. reviews.list') },
  async ({ methodId }) => {
    const m = getMethod(methodId);
    if (!m) throw new Error(`Unknown methodId "${methodId}". Use play_search_api to find one.`);
    return {
      methodId: m.id,
      httpMethod: m.method,
      path: m.path,
      canCallNow: m.method === 'GET',
      note:
        m.method === 'GET'
          ? undefined
          : 'This method changes data. Do not call it with play_call. Use play_prepare_change (preview + ticket), then play_apply_change after the owner confirms.',
      requiresRequestBody: Boolean(m.hasBody),
      supportsFileUpload: Boolean(m.mediaUpload),
      autoFilled: 'packageName defaults to the configured app; editId is opened and closed automatically for reads.',
      params: m.params,
    };
  },
);

readTool(
  'play_call',
  'Call any Play Developer API READ method (GET) by methodId. Methods that would change data are refused here; use play_prepare_change for those. Path and query parameters go together in params. packageName defaults to the configured app, and editId is handled automatically.',
  {
    methodId: z.string().describe('A methodId from play_search_api, e.g. edits.listings.list'),
    params: z.record(z.string(), z.string()).optional().describe('Path and query parameters, e.g. {"maxResults":"10"}'),
  },
  async ({ methodId, params }) => {
    const m = getMethod(methodId);
    if (!m) throw new Error(`Unknown methodId "${methodId}". Use play_search_api to find one.`);
    if (m.method !== 'GET') {
      throw new Error(
        `${m.id} is a ${m.method} method that changes data, so play_call will not run it. Use play_prepare_change to get a preview and a ticket, then play_apply_change after the owner confirms.`,
      );
    }
    const { pathValues, query, pathNames } = splitParams(m, params || {});
    if (pathNames.includes('packageName') && !pathValues.packageName) pathValues.packageName = resolvePackage();
    if (pathValues.packageName) resolvePackage(pathValues.packageName); // validates the format
    const run = (editId) => {
      if (editId) pathValues.editId = editId;
      const reserved = m.params.filter((p) => p.reserved).map((p) => p.name);
      return playRequest('GET', fillPath(m.path, pathValues, reserved), query);
    };
    if (pathNames.includes('editId') && !pathValues.editId) return withTemporaryEdit(pathValues.packageName, run);
    return run();
  },
);

// ---- guarded writes: prepare (preview) then apply (execute that exact ticket) ----

readTool(
  'play_prepare_change',
  'STEP 1 of changing anything in Google Play Console. Describes the exact change(s), shows current values next to new ones, assigns a safety tier (1 low-risk, 2 needs the owner\'s confirmation, 3 blocked) and returns a one-time ticket valid for 10 minutes. Edit-based changes (listings, tracks, details...) are bundled into ONE Play edit that is committed all-or-nothing. Changes NOTHING. Show the preview to the owner in plain English before applying.',
  {
    changes: z
      .array(
        z.object({
          methodId: z.string().describe('A write methodId from play_search_api (POST/PUT/PATCH), e.g. edits.listings.update'),
          params: z.record(z.string(), z.string()).optional().describe('Path and query parameters, e.g. {"language":"en-US"}. packageName defaults to the configured app; editId is automatic.'),
          body: z.record(z.string(), z.unknown()).optional().describe('JSON request body for the method'),
        }),
      )
      .min(1)
      .max(10)
      .describe('One or more changes to apply together'),
  },
  async ({ changes }) => {
    const preview = await prepareChange({ changes, deps: writeDeps });
    audit(PLUGIN, {
      tool: 'play_prepare_change',
      kind: 'prepare',
      operations: preview.operations || preview.changes?.map((c) => ({ methodId: c.methodId, path: c.path })),
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
    { description, inputSchema: { ticket: z.string().describe('The ticket from play_prepare_change') }, annotations },
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
          app: out.app,
          tier: out.tier,
          committed: out.committed,
          sensitive: sensitiveTool || undefined,
          methods: out.results?.map((r) => r.methodId),
          beforeJson: JSON.stringify(out.before ?? null).slice(0, 4000),
          afterJson: JSON.stringify(out.results ?? null).slice(0, 4000),
        });
        return ok(out);
      } catch (err) {
        audit(PLUGIN, { tool: name, kind: 'write', ok: false, ms: Date.now() - started, ticket, error: String(err.message || err) });
        return fail(err);
      }
    },
  );
}

registerApply(
  'play_apply_change',
  'STEP 2 of changing anything in Google Play Console: executes EXACTLY the change(s) previewed by play_prepare_change, once (edit-based changes are committed together, or discarded if any fails). Only call this after the owner has explicitly said yes to the preview. Refused if writes are switched off or the ticket is unknown, expired or used.',
  false,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
);

registerApply(
  'play_apply_safe_change',
  'Like play_apply_change, but ONLY accepts Tier 1 (low-risk) tickets, so it can be allowed to run without a prompt. Refuses anything that needs the owner\'s confirmation. (No Tier 1 rules exist yet for Google Play.)',
  true,
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
);

registerApply(
  'play_apply_sensitive_change',
  'Applies ONLY critical changes (users and permissions, app signing, refunds and orders), and only ones previewed by a prepare tool that said to use this tool. It is separate from play_apply_change so that allowing that tool can never cover a critical change. Only call this after the owner has read the preview and explicitly said yes.',
  false,
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  true,
);

// ---- settings (the in-chat part of /hypercaffium-play:setup) ----------------------

function settingsView() {
  const cfg = loadConfig();
  return {
    settingsFile: CONFIG_PATH,
    configured: cfg.configured,
    credentialsProblems: configProblems(cfg),
    defaultPackageName: cfg.defaultPackageName || null,
    writesEnabled: cfg.writesEnabled,
    features: describeFeatures(currentFeatures(), 'play'),
    toolsLoadedFor: Object.keys(STARTUP_FEATURES).filter((k) => STARTUP_FEATURES[k]),
    criticalSettings: `Critical features can only be switched ON in the terminal menu. Open a terminal window (not this chat) and run: node "${SETUP_SCRIPT}"`,
    restartNote: 'After changing features, restart Claude Code so the dedicated tools match. Switching a feature off takes effect immediately either way.',
  };
}

readTool(
  'play_settings',
  "Show this plugin's settings: whether credentials are set up, the default app, the writes master switch, and every feature switch grouped by risk level (low, medium, high, critical) with what it covers. Read-only.",
  {},
  async () => settingsView(),
);

server.registerTool(
  'play_save_settings',
  {
    description:
      "Save this plugin's settings file (used by /hypercaffium-play:setup). Only change what the owner chose in this conversation. Critical features (users, signing, refunds) can be switched OFF here but never ON: that needs the terminal menu. Writes the JSON file safely (paths are escaped for you).",
    inputSchema: {
      serviceAccountKeyPath: z.string().optional().describe('Full path to the service-account .json key file'),
      defaultPackageName: z.string().regex(/^[A-Za-z0-9._]+$/).optional().describe('Android package name, e.g. com.example.app'),
      timezone: z.string().optional().describe('IANA time zone such as America/New_York'),
      writesEnabled: z.boolean().optional().describe('Master switch for all changes'),
      features: z.record(z.string(), z.boolean()).optional().describe('Feature switches to change, e.g. {"uploads": false}'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      if (args.serviceAccountKeyPath && !/\.json$/i.test(args.serviceAccountKeyPath)) throw new Error('serviceAccountKeyPath must point to the .json key file.');
      if (args.timezone) new Intl.DateTimeFormat('en-US', { timeZone: args.timezone });
      const turnedOnCritical = Object.entries(args.features || {}).filter(([k, v]) => v && isCritical(k) && !currentFeatures()[k]);
      if (turnedOnCritical.length) {
        throw new Error(`${turnedOnCritical.map(([k]) => k).join(', ')} can only be switched on in the terminal menu: open a terminal window and run node "${SETUP_SCRIPT}"`);
      }
      saveSettings(CONFIG_PATH, args, 'play');
      audit(PLUGIN, { tool: 'play_save_settings', kind: 'settings', ok: true, changed: Object.keys(args) });
      return ok({ saved: true, ...settingsView() });
    } catch (err) {
      audit(PLUGIN, { tool: 'play_save_settings', kind: 'settings', ok: false, error: String(err.message || err) });
      return fail(err);
    }
  },
);

// ---- release workflows (previews + tickets; nothing changes until play_apply_change runs) ----

const notesSchema = z
  .array(z.object({ language: z.string().describe('Language code such as en-US'), text: z.string().describe('Release notes, 500 characters max. Use an empty string to CLEAR the note for that language.') }))
  .describe('Release notes per language. Leaving this out keeps the existing notes unchanged.');

featureTool('releases',
  'play_set_release',
  'Prepare setting a release on a track: which version codes, its status (draft, inProgress staged rollout, completed, halted), rollout fraction and release notes. Checks the version codes were really uploaded. Previews before/after and returns a ticket (Tier 2). Production reaches real users.',
  {
    packageName,
    track: z.string().describe('internal, alpha, beta, production, or a custom track'),
    versionCodes: z.array(z.number().int()).min(1).describe('Uploaded version codes, e.g. [6]'),
    status: z.enum(['draft', 'inProgress', 'completed', 'halted']),
    userFraction: z.number().optional().describe('Staged rollout fraction for inProgress, between 0 and 1 (0.1 = 10%)'),
    releaseNotes: notesSchema.optional(),
    name: z.string().optional().describe('Release name (Google picks one if omitted)'),
  },
  (a) => prepareSetRelease(writeDeps, a),
);

featureTool('releases',
  'play_rollout',
  'Prepare a staged-rollout action on a track (default production): increase to a larger percentage, halt, resume, or complete (everyone). Shows the current and new percentage and returns a ticket (Tier 2).',
  {
    packageName,
    track: z.string().default('production'),
    action: z.enum(['increase', 'halt', 'resume', 'complete']),
    userFraction: z.number().optional().describe('New fraction for "increase" (e.g. 0.5 for 50%); must be above the current one'),
  },
  (a) => prepareRollout(writeDeps, a),
);

featureTool('releases',
  'play_promote_release',
  'Prepare promoting the current release of one track to another (default internal to production). Production defaults to a 10% staged rollout; release notes are carried over unless you give new ones. Tier 2.',
  {
    packageName,
    fromTrack: z.string().default('internal'),
    toTrack: z.string().describe('alpha, beta or production'),
    userFraction: z.number().optional().describe('Staged rollout fraction for production (default 0.1); 1 means everyone'),
    releaseNotes: notesSchema.optional(),
  },
  (a) => preparePromote(writeDeps, a),
);

featureTool('releases',
  'play_set_release_notes',
  'Prepare changing the release notes of a draft, in-progress or halted release on a track (Google does not allow changing a completed release). Shows old and new text per language. Tier 2.',
  { packageName, track: z.string().default('production'), releaseNotes: notesSchema },
  (a) => prepareReleaseNotes(writeDeps, a),
);

// ---- uploading app files -----------------------------------------------------------

featureTool(
  'uploads',
  'play_upload_bundle',
  'Prepare uploading an Android App Bundle (.aab) from this computer, optionally with its R8/ProGuard mapping.txt so crash reports are readable, and putting it on a track (default internal). Only internal, alpha and beta can go live straight from an upload; any other track (production included) gets a DRAFT release. Upload, mapping and track change are committed together in one Play edit, or not at all. Tier 2. Skip this if EAS or Gradle uploads your builds.',
  {
    packageName,
    file: z.string().describe('Full path to the .aab file'),
    mappingFile: z.string().optional().describe('Full path to mapping.txt from the same build (optional)'),
    track: z.string().default('internal').describe('internal, alpha, beta, production, or a closed track'),
    status: z.enum(['draft', 'completed', 'inProgress']).optional().describe('internal/alpha/beta default to completed; every other track is always draft'),
    userFraction: z.number().optional().describe('For inProgress: rollout fraction, e.g. 0.1'),
    releaseNotes: notesSchema.optional(),
  },
  (a) => prepareUploadBundle(writeDeps, a),
);

// ---- testers ------------------------------------------------------------------------

readTool(
  'play_list_testers',
  'The Google Groups that can test each testing track (internal, closed, open). Read-only. Individual tester email lists are console-only.',
  { packageName },
  (a) => listTesters(writeDeps, a),
);

featureTool(
  'testing',
  'play_set_testers',
  'Prepare adding and/or removing Google Groups as testers of one testing track. Shows the list before and after; applied inside one Play edit. Tier 2.',
  {
    packageName,
    track: z.string().describe('internal, alpha, beta, or a closed track name'),
    add: z.array(z.string()).default([]).describe('Google Group emails to add'),
    remove: z.array(z.string()).default([]).describe('Google Group emails to remove'),
  },
  (a) => prepareSetTesters(writeDeps, a),
);

// ---- reviews, listing, images, subscriptions -----------------------------------------

featureTool('reviews',
  "play_reply_to_review",
  "Prepare a PUBLIC reply to a Google Play review (350 characters max). Shows the review and any existing reply that would be replaced, and returns a ticket (Tier 2, needs the owner's explicit yes). Needs the Reply to reviews permission.",
  { packageName, reviewId: z.string().describe("Review id from play_list_reviews"), text: z.string() },
  (a) => prepareReplyToReview(writeDeps, a),
);

featureTool('listing',
  "play_edit_listing",
  "Prepare editing the store listing text for one language: title (30), shortDescription (80), fullDescription (4000), video URL. Shows before and after and returns a ticket (Tier 2: it is public as soon as it is committed). Needs the Manage store presence permission.",
  {
    packageName,
    language: z.string().default("en-US"),
    title: z.string().optional(),
    shortDescription: z.string().optional(),
    fullDescription: z.string().optional(),
    video: z.string().optional(),
  },
  ({ packageName: p, language, ...fields }) => prepareEditListing(writeDeps, { packageName: p, language, fields }),
);

featureTool('listing',
  "play_upload_images",
  "Prepare uploading listing images (icon, featureGraphic, phoneScreenshots, sevenInchScreenshots, tenInchScreenshots, tvBanner, tvScreenshots, wearScreenshots) from local PNG or JPEG files. Validates sizes against Google's rules, adds only (never deletes), and commits all uploads together or not at all. Tier 2. Needs the Manage store presence permission.",
  {
    packageName,
    language: z.string().default("en-US"),
    imageType: z.string().describe("For example phoneScreenshots, icon (512x512), featureGraphic (1024x500)"),
    files: z.array(z.string()).min(1).max(8).describe("Full paths to the image files, in display order"),
  },
  (a) => prepareUploadImages(writeDeps, a),
);

featureTool(
  'listing',
  'play_replace_images',
  "Prepare REPLACING a whole listing image set (for example all phone screenshots for en-US) with new local PNG or JPEG files. The preview lists every image that will be removed (with a link to save it first) and every new file. Removing and uploading happen in ONE Play edit, committed together or not at all, so the listing is never left half-empty. Tier 2: needs the owner's explicit yes.",
  {
    packageName,
    language: z.string().default('en-US'),
    imageType: z.string().describe('For example phoneScreenshots, sevenInchScreenshots, featureGraphic'),
    files: z.array(z.string()).min(1).max(8).describe('Full paths to ALL the new images, in display order'),
  },
  (a) => prepareReplaceImages(writeDeps, a),
);

readTool(
  "play_subscription_overview",
  "List the app's Google Play subscriptions: product ids, titles, base plans (state, billing period, number of regions). Read-only. Needs the Manage orders and subscriptions permission. Edits go through play_prepare_change.",
  { packageName },
  async ({ packageName: p }) => subscriptionOverview((path, q) => playRequest("GET", path, q), resolvePackage(p)),
);

featureTool(
  'pricing',
  'play_set_subscription_price',
  "Prepare changing a subscription base plan's price. Google converts the price into each region's local currency; the preview shows a per-region table (old, new, percent). It applies to NEW subscribers only: existing subscribers keep their price until play_migrate_subscription_prices. Tier 2, never automatic. Ask the owner for the exact amount and which regions; never infer a price from a vague request.",
  {
    packageName,
    productId: z.string().describe('Subscription product id from play_subscription_overview'),
    basePlanId: z.string().describe('Base plan id, e.g. monthly'),
    price: z.number().describe('The new price, e.g. 2.99'),
    currency: z.string().default('USD').describe('Currency of that price'),
    regions: z.union([z.literal('all'), z.array(z.string())]).default('all').describe('"all", or region codes such as ["US","CA"]'),
    includeOtherRegions: z.boolean().default(true).describe('With "all": also update the price for regions Google adds later'),
  },
  (a) => prepareSetSubscriptionPrice(writeDeps, a),
);

featureTool(
  'pricing',
  'play_migrate_subscription_prices',
  "Prepare moving EXISTING subscribers of a base plan to its current price (after a price change). This changes what paying customers are charged: the preview spells out who is affected, the opt-in or opt-out rules, and the current prices. Tier 2. Only on the owner's explicit request, with the regions and opt-in/opt-out confirmed.",
  {
    packageName,
    productId: z.string(),
    basePlanId: z.string(),
    regions: z.union([z.literal('all'), z.array(z.string())]).default('all'),
    increaseType: z.enum(['OPT_IN', 'OPT_OUT']).default('OPT_IN').describe('For price increases: OPT_IN (customers must accept) or OPT_OUT (charged unless they cancel; limited by Google)'),
    oldestAllowedPriceVersionTime: z.string().optional().describe('Subscribers on prices set before this time are moved (default: now, so everyone on an older price)'),
  },
  (a) => prepareMigratePrices(writeDeps, a),
);

readTool(
  'play_check_changes',
  'What changed in Google Play since the last check: release status and staged-rollout progress on every track, and new user reviews. The first call saves a baseline. Run it periodically (for example with /loop or a scheduled routine) to be told about changes.',
  { packageName },
  async ({ packageName: p }) => {
    const pkg = resolvePackage(p);
    return googleCheckChanges({
      packageName: pkg,
      fetchTracks: async () =>
        (await withTemporaryEdit(pkg, (editId) => playRequest('GET', `${APP_BASE}/${pkg}/edits/${editId}/tracks`))).tracks || [],
      fetchReviews: async () => (await playRequest('GET', `${APP_BASE}/${pkg}/reviews`, { maxResults: 50 })).reviews || [],
    });
  },
);

readTool(
  'play_audit_log',
  "Show the most recent entries of this plugin's activity log (which tools ran, with what arguments, success or failure). The log file lives in ~/.claude-plugins/audit/.",
  { limit: z.number().int().min(1).max(100).default(20).describe('How many entries (newest first)') },
  async ({ limit }) => readAudit(PLUGIN, limit).map((e) => ({ ...e, whenLocal: toLocalTime(e.ts) })),
);

await server.connect(new StdioServerTransport());
