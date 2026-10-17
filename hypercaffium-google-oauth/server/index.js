#!/usr/bin/env node
// Google OAuth setup MCP server. Reads are plain tools. Every change goes through two steps:
// google_prepare_change (preview + one-time ticket), then google_apply_change (or the separate
// sensitive tool for critical changes) after the owner says yes. Console steps are done by Claude
// with Kapture and must be recorded with google_record_console_result. Everything is audited.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { audit, readAudit } from './audit.js';
import { CONFIG_PATH, PLUGIN, loadConfig } from './config.js';
import { ACTIONS, PAGES, labelsFor, pageUrl } from './console.js';
import { PROJECT_ID, activeAccount, enableService, enabledServices, listProjects, resolveGcloud } from './gcloud.js';
import { checkAccounts, evaluateConsole } from './health.js';
import { getRecipe, isBuiltinRecipe, listRecipes, saveRecipe } from './recipes.js';
import { installClientFile, signInAccount } from './signin.js';
import { TicketStore, applyChange, prepareChange, recordConsoleResult } from './writes.js';
import { describeFeatures, saveSettings } from '../../shared/features.js';

const VERSION = '0.1.0';
// loadConfig() honors this override, so saving must write the same file it reads.
const SETTINGS_FILE = process.env.HYPERCAFFIUM_GOOGLE_OAUTH_CONFIG || CONFIG_PATH;
const KAPTURE_NOTE = 'Console steps need the Kapture browser extension connected; without it they come back as manual steps.';

// Keep tool results small enough to be useful; say so clearly when something was cut.
const MAX_OUTPUT_CHARS = 60000;
function limitText(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... output cut at ${max} characters; ask for fewer items ...]`;
}
const ok = (value) => ({ content: [{ type: 'text', text: limitText(JSON.stringify(value, null, 2)) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: String(err.message || err) }] });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

// The terminal setup menu sits next to this server file once built (server/dist/setup.mjs).
const SETUP_SCRIPT = /[\\/]dist[\\/][^\\/]+$/.test(fileURLToPath(import.meta.url))
  ? fileURLToPath(new URL('./setup.mjs', import.meta.url))
  : fileURLToPath(new URL('./dist/setup.mjs', import.meta.url));

// ONE ticket store for the whole server run, so a ticket from prepare is still there at apply.
// Settings are loaded fresh on every call (they may change mid-session).
const ticketStore = new TicketStore();

function gcloudPathFor(config) {
  return resolveGcloud({ env: process.env, platform: process.platform, exists: fs.existsSync, settingsPath: config.gcloudPath });
}

function buildDeps(config) {
  const gcloudDeps = { gcloudPath: gcloudPathFor(config) };
  return {
    config,
    store: ticketStore,
    gcloud: {
      enabledServices: (projectId) => enabledServices(projectId, gcloudDeps),
      enableService: (projectId, api) => enableService(projectId, api, gcloudDeps),
    },
    signIn: { signInAccount, installClientFile },
    recipes: { getRecipe, saveRecipe, isBuiltin: isBuiltinRecipe },
  };
}

const server = new McpServer({ name: 'hypercaffium-google-oauth', version: VERSION });

// Every tool goes through here (or writeTool / registerApply) so every call is audited.
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

// A tool that changes local files or tickets (not Google) but is not read-only.
function writeTool(name, description, inputSchema, annotations, handler, summarize = () => ({})) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    const started = Date.now();
    try {
      const result = await handler(args || {});
      audit(PLUGIN, { tool: name, kind: 'write', ok: true, ms: Date.now() - started, ...summarize(args || {}, result) });
      return ok(result);
    } catch (err) {
      audit(PLUGIN, { tool: name, kind: 'write', ok: false, ms: Date.now() - started, error: String(err.message || err) });
      return fail(err);
    }
  });
}

const projectId = z.string().regex(PROJECT_ID).describe('Google Cloud project id, e.g. my-app-123456');
const recipeName = z.string().describe('Recipe name from google_list_recipes, e.g. mcp-google-workspace');

function settingsView() {
  const cfg = loadConfig();
  return {
    settingsFile: SETTINGS_FILE,
    writesEnabled: cfg.writesEnabled,
    liveProjects: cfg.liveProjects,
    gcloudPath: cfg.gcloudPath,
    expectedAccount: cfg.expectedAccount,
    features: describeFeatures(cfg.features, 'google'),
    criticalSettings: `Critical features can only be switched ON in the terminal menu. Open a terminal window (not this chat) and run: node "${SETUP_SCRIPT}"`,
  };
}

// ---- setup and settings ------------------------------------------------------

readTool(
  'google_check_setup',
  'Check that the Google Cloud command line tool (gcloud) is found and signed in, which account it uses compared with the expected one, and the settings summary. Run this first if any other google_ tool fails. Console steps need the Kapture browser extension.',
  {},
  async () => {
    const cfg = loadConfig();
    const gcloudPath = gcloudPathFor(cfg);
    const gcloud = { path: gcloudPath, account: null, expectedAccount: cfg.expectedAccount, accountMatches: null };
    if (!gcloudPath) {
      gcloud.problem = 'gcloud was not found. Install the Google Cloud CLI from https://cloud.google.com/sdk/docs/install or set gcloudPath in the settings.';
    } else {
      try {
        gcloud.account = await activeAccount({ gcloudPath });
        if (!gcloud.account) gcloud.problem = 'gcloud is not signed in. Run "gcloud auth login" in a terminal.';
        else if (cfg.expectedAccount) gcloud.accountMatches = gcloud.account.toLowerCase() === cfg.expectedAccount.toLowerCase();
      } catch (err) {
        gcloud.problem = String(err.message || err);
      }
    }
    return {
      gcloud,
      settingsFile: SETTINGS_FILE,
      writesEnabled: cfg.writesEnabled,
      liveProjects: cfg.liveProjects,
      features: describeFeatures(cfg.features, 'google'),
      kapture: KAPTURE_NOTE,
      writesNote: cfg.writesEnabled
        ? 'Writes are ON: changes need google_prepare_change then google_apply_change.'
        : 'Writes are OFF (kill switch). Previews still work. Turn them on with google_save_settings or /hypercaffium-google-oauth:setup.',
    };
  },
);

readTool(
  'google_settings',
  "Show this plugin's settings: the writes master switch, live projects, gcloud path, expected account, and every feature switch grouped by risk level. Read-only.",
  {},
  async () => settingsView(),
);

writeTool(
  'google_save_settings',
  "Save this plugin's settings file (used by /hypercaffium-google-oauth:setup). Only change what the owner chose in this conversation. Critical features can be switched OFF here but never ON: that needs the terminal menu. Changes a local file only, no ticket needed. The gcloud program location cannot be set from chat (it is found automatically; the owner can edit gcloudPath in the settings file by hand). Live projects can only be added from chat; removing one means editing the settings file by hand (~/.claude-plugins/hypercaffium-google-oauth.json, the liveProjects list).",
  {
    writesEnabled: z.boolean().optional().describe('Master switch for all changes'),
    liveProjects: z.array(z.string().regex(PROJECT_ID)).optional().describe('Project ids whose users are real (changes there get extra warnings and a separate feature switch)'),
    expectedAccount: z.string().email().optional().describe('The Google account gcloud should be signed in as'),
    features: z.record(z.string(), z.boolean()).optional().describe('Feature switches to change, e.g. {"apis": false}'),
  },
  { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async (args) => {
    if (args.liveProjects) {
      const current = loadConfig().liveProjects;
      const dropped = current.filter((id) => !args.liveProjects.includes(id));
      if (dropped.length) {
        throw new Error(`Removing a live project (${dropped.join(', ')}) cannot be done from chat. To remove one, edit the settings file by hand (~/.claude-plugins/hypercaffium-google-oauth.json, the liveProjects list). Chat can only add live projects.`);
      }
      args = { ...args, liveProjects: [...new Set([...current, ...args.liveProjects])] };
    }
    saveSettings(SETTINGS_FILE, args, 'google');
    return { saved: true, ...settingsView(), restartNote: 'Switching a feature off takes effect immediately.' };
  },
  (args) => ({ changed: Object.keys(args) }),
);

// ---- projects ------------------------------------------------------------------

readTool(
  'google_list_projects',
  'List the Google Cloud projects the signed-in gcloud account can see (project id and name).',
  {},
  async () => listProjects({ gcloudPath: gcloudPathFor(loadConfig()) }),
);

readTool(
  'google_project_status',
  'One project at a glance: which APIs are enabled, whether it is marked live in the settings, and the console page address for every Google Auth Platform page (read those with Kapture to see publishing status, clients, scopes and test users).',
  { projectId },
  async ({ projectId: id }) => {
    const cfg = loadConfig();
    return {
      projectId: id,
      live: cfg.liveProjects.includes(id),
      enabledApis: await enabledServices(id, { gcloudPath: gcloudPathFor(cfg) }),
      consolePages: Object.fromEntries(Object.keys(PAGES).map((p) => [p, pageUrl(p, id)])),
      kapture: KAPTURE_NOTE,
    };
  },
);

readTool(
  'google_console_page',
  'The address of one Google Auth Platform console page, what to read on it, and the labels that should be visible on it (used by the self-test). Open it with Kapture and report only what you actually see. Read-only: this does not change anything.',
  { projectId, page: z.enum(Object.keys(PAGES)).describe('Which console page') },
  async ({ projectId: id, page }) => ({
    url: pageUrl(page, id),
    read: PAGES[page].read,
    labels: labelsFor(page),
    howTo: 'Open the url with Kapture, confirm you are signed in to the right Google account, then report the values for the fields listed in "read". Say so if a field is not visible.',
    kapture: KAPTURE_NOTE,
  }),
);

// ---- recipes -------------------------------------------------------------------

readTool(
  'google_list_recipes',
  'List the recipes (built-in and your own). A recipe describes one tool that needs Google sign-in: its APIs, scopes, client file, accounts file, login command and token location.',
  {},
  async () => listRecipes(),
);

// ---- health --------------------------------------------------------------------

readTool(
  'google_check_accounts',
  'Check the saved sign-in of each account for a recipe against Google: still valid, which scopes it has, and which are missing. Never shows tokens. Emails default to the accounts listed in the recipe accounts file.',
  { recipe: recipeName, emails: z.array(z.string().email()).optional().describe('Only check these accounts') },
  async ({ recipe, emails }) => checkAccounts({ recipe: getRecipe(recipe), emails }),
);

readTool(
  'google_evaluate_console',
  'After reading the Google Auth Platform pages with Kapture, pass what you saw (for example publishingStatus, scopes, testUsers) and get a verdict per check. Only values you actually observed may be passed.',
  { recipe: recipeName, observed: z.record(z.string(), z.any()).describe('What you read in the console, e.g. {"publishingStatus":"In production","scopes":["..."]}') },
  async ({ recipe, observed }) => evaluateConsole({ recipe: getRecipe(recipe), observed }),
);

// ---- the two-step change flow --------------------------------------------------

readTool(
  'google_prepare_change',
  `STEP 1 of changing anything for Google sign-in: previews the change (before and after), classifies its risk and returns a one-time ticket (valid 10 minutes). Changes nothing. Valid actions: ${Object.keys(ACTIONS).join(', ')}. Show the owner the preview and, only after an explicit yes, call STEP 2: google_apply_change (or google_apply_sensitive_change when the preview says so).`,
  {
    projectId: projectId.optional().describe('Google Cloud project id. Not used for save_recipe.'),
    action: z.string().describe(`One of: ${Object.keys(ACTIONS).join(', ')}`),
    params: z.record(z.string(), z.any()).optional().describe('Action details, e.g. {"api":"gmail.googleapis.com"} for enable_api, {"email":"a@b.com"} for add_test_user, {"recipe":{...}} for save_recipe (saving a recipe also needs this two-step approval). Keys per action: enable_api {api}; add_scopes/remove_scopes {scopes}; set_branding {fields:{appName, supportEmail, homepage, privacyPolicy, termsOfService, developerEmail}}; create_client {recipe, name, clientType?, allowOverwrite?}; sign_in_account {recipe, email, accountType?, note?}; add_test_user {email}; set_user_type {userType}; delete_client {name}; save_recipe {recipe}. For console actions also pass currentObserved: what you just read on the page, with the same keys as consolePlan.expected, so the preview and any live-project warning show the real before.'),
  },
  async (args) => {
    const cfg = loadConfig();
    const preview = await prepareChange(args, buildDeps(cfg));
    return { ...preview, writesEnabled: cfg.writesEnabled };
  },
);

function registerApply(name, description, annotations, sensitiveTool) {
  server.registerTool(
    name,
    { description, inputSchema: { ticket: z.string().describe('The ticket from google_prepare_change') }, annotations },
    async ({ ticket }) => {
      const started = Date.now();
      try {
        const out = await applyChange({ ticketId: ticket, sensitiveTool }, buildDeps(loadConfig()));
        audit(PLUGIN, { tool: name, kind: 'write', ok: true, ms: Date.now() - started, ticket, sensitive: sensitiveTool || undefined, applied: out.applied, api: out.api });
        return ok(out);
      } catch (err) {
        audit(PLUGIN, { tool: name, kind: 'write', ok: false, ms: Date.now() - started, ticket, error: String(err.message || err) });
        return fail(err);
      }
    },
  );
}

registerApply(
  'google_apply_change',
  'STEP 2 of changing anything for Google sign-in: executes EXACTLY the change previewed by google_prepare_change, once. gcloud and sign-in changes run now; console changes return the steps for Kapture, and you must then call google_record_console_result. Only call this after the owner has explicitly said yes to the preview. Refused if writes are switched off or the ticket is unknown, expired or used.',
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  false,
);

registerApply(
  'google_apply_sensitive_change',
  'Applies ONLY critical changes (removing scopes, deleting clients, going back to testing, overwriting a client file), and only ones whose preview said to use this tool. It is separate from google_apply_change so that allowing that tool can never cover a critical change. Only call this after the owner has read the preview and explicitly said yes.',
  { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  true,
);

writeTool(
  'google_record_console_result',
  'After performing the steps from google_apply_change with Kapture, record what the console page now shows (read it again, do not assume). The result says whether it matches what was expected. For create_client, pass downloadedFile (the JSON file in your Downloads folder) to install the client file once the match is confirmed. Never claim a console change worked without this.',
  {
    ticket: z.string().describe('The ticket that google_apply_change approved'),
    observed: z.record(z.string(), z.any()).describe('What the console page shows after the change'),
    downloadedFile: z.string().optional().describe('For create_client: full path to the downloaded client JSON file'),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ({ ticket, observed, downloadedFile }) => recordConsoleResult({ ticketId: ticket, observed, downloadedFile }, buildDeps(loadConfig())),
  ({ ticket }, out) => ({ ticket, match: out?.match }),
);

// ---- audit ---------------------------------------------------------------------

readTool(
  'google_audit_log',
  "Show the most recent entries of this plugin's activity log (which tools ran, with what arguments, success or failure). The log file lives in ~/.claude-plugins/audit/.",
  { limit: z.number().int().min(1).max(100).default(20).describe('How many entries (newest first)') },
  async ({ limit }) => readAudit(PLUGIN, limit),
);

await server.connect(new StdioServerTransport());
