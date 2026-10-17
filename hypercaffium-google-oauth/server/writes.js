// The two-step change engine for the Google OAuth plugin: prepare (preview + one-time ticket), then apply
// only after the owner says yes. Console changes are not trusted until Claude records what the page shows.
// Everything outside (gcloud, sign-in, clock, settings) is injected so each rule is testable offline.
//
// deps = { config, gcloud: { enabledServices, enableService }, signIn: { signInAccount, installClientFile },
//          recipes: { getRecipe }, fs (optional, for existsSync), home (optional), now, store }   (createEngine adds the store)
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import os from 'node:os';
import { ACTIONS, consolePlan, compareObservation } from './console.js';
import { PROJECT_ID, API_NAME } from './gcloud.js';
import { classify } from './rules.js';
import { expand, recipeHash, validateRecipe } from './recipes.js';

export { classify };

const NEXT_CONSOLE = 'Perform the steps with Kapture, then call google_record_console_result';
const UNREAD = '(read the page first)';

// ---- tickets (10 minutes, single use) ---------------------------------------
// States: prepared -> approved (console changes only, after apply) -> recorded. A failed execution
// becomes "failed" and can never be retried on the same ticket.

export class TicketStore {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.tickets = new Map();
  }

  create(payload) {
    const id = crypto.randomBytes(9).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(id, { id, payload, expiresAt, state: 'prepared' });
    return { id, expiresAt };
  }

  // Returns the ticket if it exists, has not expired and is in the wanted state.
  peek(id, wantState = 'prepared') {
    const t = this.tickets.get(id);
    if (!t) throw new Error('Unknown ticket. Prepare the change again (tickets only live in this session).');
    if (this.now() > t.expiresAt) {
      this.tickets.delete(id);
      throw new Error('That ticket expired (10 minutes). Prepare the change again to get a fresh preview.');
    }
    if (t.state !== wantState) {
      if (wantState === 'approved') {
        throw new Error(t.state === 'prepared'
          ? 'That ticket has not been applied yet. Apply the change (after the owner says yes) before recording a console result.'
          : 'That ticket already has a recorded result. Tickets work once.');
      }
      throw new Error('That ticket was already applied. Tickets work once.');
    }
    return t;
  }

  setState(id, state) {
    const t = this.tickets.get(id);
    if (t) t.state = state;
  }

  // Console steps take time, so approval gives the ticket a fresh window to record the result.
  extend(id) {
    const t = this.tickets.get(id);
    if (t) t.expiresAt = this.now() + this.ttlMs;
  }
}

// ---- prepare ----------------------------------------------------------------

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ACCOUNT_TYPE = /^[A-Za-z0-9 _-]*$/;
const NOTE = /^[^\x00-\x1f\x7f"'{}`$%&|;<>]*$/;
const checkEmail = (e) => {
  if (typeof e !== 'string' || !EMAIL.test(e)) throw new Error('email must be a plain email address such as name@example.com.');
};
// The only params each action accepts (anything else is dropped before the ticket is stored).
const ALLOWED_PARAMS = {
  enable_api: ['api'],
  sign_in_account: ['recipe', 'email', 'accountType', 'note'],
  save_recipe: ['recipe'],
  create_client: ['recipe', 'name', 'clientType', 'allowOverwrite'],
  add_scopes: ['scopes'],
  remove_scopes: ['scopes'],
  add_test_user: ['email'],
  set_branding: ['fields'],
  set_user_type: ['userType'],
  delete_client: ['name'],
  publish: [],
  back_to_testing: [],
};

// Checks the params that the console module does not check, and fills in defaults.
function normalizeParams(action, params, deps) {
  // Keep only the params this action understands, so nothing hidden rides along to apply or record.
  const p = {};
  for (const k of ALLOWED_PARAMS[action] || []) if (params[k] !== undefined) p[k] = params[k];
  if (action === 'enable_api') {
    if (typeof p.api !== 'string' || !API_NAME.test(p.api)) throw new Error('api must be a service name such as gmail.googleapis.com.');
  } else if (action === 'sign_in_account') {
    if (!p.recipe) throw new Error('recipe is required.');
    checkEmail(p.email);
    if (p.accountType !== undefined && (typeof p.accountType !== 'string' || p.accountType.length > 30 || !ACCOUNT_TYPE.test(p.accountType))) {
      throw new Error('accountType must be at most 30 letters, digits, spaces, hyphens or underscores.');
    }
    if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 120 || !NOTE.test(p.note))) {
      throw new Error('note must be at most 120 characters with no quotes, braces, backticks, control characters or the symbols $ % & | ; < >.');
    }
    deps.recipes.getRecipe(p.recipe);
  } else if (action === 'save_recipe') {
    if (!p.recipe || typeof p.recipe !== 'object' || Array.isArray(p.recipe)) throw new Error('recipe must be a recipe object.');
    validateRecipe(p.recipe, { home: deps.home });
    if (deps.recipes.isBuiltin?.(p.recipe.name)) throw new Error(`"${p.recipe.name}" is a built-in recipe name and cannot be overwritten.`);
  } else if (action === 'add_test_user') {
    checkEmail(p.email);
  } else if (action === 'create_client') {
    if (!p.recipe) throw new Error('recipe is required.');
    const recipe = deps.recipes.getRecipe(p.recipe);
    if (!p.clientType) p.clientType = recipe.clientType;
    p.allowOverwrite = p.allowOverwrite === true;
  }
  return p;
}

function afterPicture(action, p) {
  switch (action) {
    case 'enable_api': return `${p.api} is on`;
    case 'save_recipe': return `the recipe "${p.recipe.name}" is saved in your recipes folder`;
    case 'sign_in_account': return `${p.email} is signed in (recipe ${p.recipe}, account type ${p.accountType || '(none)'}, note ${p.note ? `"${p.note}"` : '(none)'})`;
    case 'create_client': return `a ${p.clientType} client named "${p.name}" exists`;
    case 'add_scopes': return `scopes added: ${p.scopes.join(', ')}`;
    case 'remove_scopes': return `scopes removed: ${p.scopes.join(', ')}`;
    case 'add_test_user': return `${p.email} is a test user`;
    case 'set_branding': return `branding set: ${Object.entries(p.fields || {}).map(([k, v]) => `${k}=${v}`).join(', ')}`;
    case 'set_user_type': return `user type is ${p.userType}`;
    case 'delete_client': return `the client "${p.name}" is deleted`;
    case 'publish': return 'publishing status is In production (anyone can sign in)';
    case 'back_to_testing': return 'publishing status is Testing (only listed test users can sign in)';
    default: return '';
  }
}

// The exact places a recipe will run and write, with {home} expanded and {email} left as a placeholder.
function describeRecipe(recipe, home, email) {
  const vars = email ? { home, email } : { home };
  const out = { name: recipe.name };
  if (recipe.login) {
    out.loginCommand = expand(recipe.login.command || '', vars);
    out.loginCwd = recipe.login.cwd ? expand(recipe.login.cwd, vars) : home;
  }
  if (recipe.clientFile) out.clientFile = expand(recipe.clientFile, vars);
  if (recipe.accountsFile?.path) out.accountsFile = expand(recipe.accountsFile.path, vars);
  if (recipe.tokens?.path) out.tokensPath = expand(recipe.tokens.path, vars);
  return out;
}

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

export async function prepareChange({ projectId, action, params = {} } = {}, deps) {
  // Saving a recipe is not about any project, so it needs no project id.
  if (action === 'save_recipe') projectId = undefined;
  else if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) {
    throw new Error('projectId must be a Google Cloud project id (6 to 30 lowercase letters, digits or hyphens).');
  }
  if (!ACTIONS[action]) throw new Error(`Unknown action "${action}". Valid actions: ${Object.keys(ACTIONS).join(', ')}.`);

  const mode = ACTIONS[action].mode;
  const live = projectId !== undefined && deps.config.liveProjects.includes(projectId);
  const verdict = classify(action, { projectId, live, features: deps.config.features, params });
  if (verdict.tier === 3) {
    return { allowed: false, blocked: true, tier: 3, feature: verdict.feature, live, reason: verdict.reason };
  }

  const p = normalizeParams(action, params, deps);
  const plan = mode === 'console' ? consolePlan(action, projectId, p) : undefined;

  let before;
  let alreadyOn = false;
  if (action === 'enable_api') {
    const enabled = await deps.gcloud.enabledServices(projectId);
    alreadyOn = enabled.includes(p.api);
    before = alreadyOn ? `${p.api} is already on` : `${p.api} is off`;
  } else if (mode === 'console') {
    before = params.currentObserved !== undefined ? show(params.currentObserved) : UNREAD;
  } else {
    before = '(not checked)';
  }
  const home = deps.home || os.homedir();
  let after = afterPicture(action, p);
  if (action === 'create_client') {
    const recipe = deps.recipes.getRecipe(p.recipe);
    const clientFile = recipe.clientFile ? expand(recipe.clientFile, { home }) : undefined;
    const exists = clientFile ? (deps.fs || nodeFs).existsSync(clientFile) : false;
    if (exists && p.allowOverwrite !== true) {
      throw new Error(`The tool already has a client file at ${clientFile}. To replace it, prepare again with allowOverwrite: true (a critical change that needs google_apply_sensitive_change).`);
    }
    if (p.allowOverwrite === true) {
      after += `. It will OVERWRITE the existing client file at ${clientFile} with the downloaded one`;
    }
  }
  const preview = { before, after };
  if (alreadyOn) preview.note = 'It is already on, so applying changes nothing.';

  // Recipes are snapshotted now; apply and record use exactly this copy and refuse if the recipe changed.
  let recipeSnapshot;
  if (action === 'save_recipe') {
    recipeSnapshot = p.recipe;
    let existing = null;
    try { existing = deps.recipes.getRecipe(p.recipe.name); } catch { /* none yet */ }
    preview.details = describeRecipe(p.recipe, home);
    if (existing) preview.note = `A recipe named "${p.recipe.name}" already exists and will be REPLACED.`;
  } else if (p.recipe && (action === 'sign_in_account' || action === 'create_client')) {
    recipeSnapshot = deps.recipes.getRecipe(p.recipe);
    if (action === 'sign_in_account') preview.details = describeRecipe(recipeSnapshot, home, p.email);
  }

  const ticket = deps.store.create({
    projectId, action, params: p, mode, tier: verdict.tier, feature: verdict.feature,
    sensitive: verdict.sensitive, live, expected: plan?.expected,
    recipeSnapshot, recipeHash: recipeSnapshot ? recipeHash(recipeSnapshot) : undefined,
  });

  const out = {
    ticket: ticket.id,
    expiresAt: new Date(ticket.expiresAt).toISOString(),
    tier: verdict.tier,
    feature: verdict.feature,
    sensitive: verdict.sensitive || undefined,
    live,
    mode,
    preview,
    reason: verdict.reason,
  };
  if (live) out.liveWarning = `${verdict.reason}\nBefore: ${before}\nAfter: ${after}`;
  if (plan) out.consolePlan = plan;
  return out;
}

// ---- apply ------------------------------------------------------------------

// Sensitive tickets need the sensitive apply tool, and that tool takes nothing else, so an
// "always allow" on the normal apply tool can never cover a critical change.
export function checkApplyTool(payload, sensitiveTool) {
  if (payload.sensitive && !sensitiveTool) {
    throw new Error('This is a CRITICAL change (removing or resetting sign-in setup). It can only be applied with the sensitive apply tool, after the owner says yes.');
  }
  if (!payload.sensitive && sensitiveTool) {
    throw new Error('The sensitive apply tool only applies critical changes. Use the normal apply tool for this ticket.');
  }
}

// A recipe-based ticket only runs if the recipe is still exactly what the owner saw in the preview.
function checkRecipeUnchanged(payload, deps) {
  if (!payload.recipeHash || payload.action === 'save_recipe') return;
  let now;
  try { now = deps.recipes.getRecipe(payload.params.recipe); } catch { now = null; }
  if (!now || recipeHash(now) !== payload.recipeHash) {
    throw new Error(`The recipe "${payload.params.recipe}" changed since the preview, so nothing was done. Prepare the change again to see the new version.`);
  }
}

export async function applyChange({ ticketId, sensitiveTool = false } = {}, deps) {
  if (!deps.config.writesEnabled) {
    throw new Error('Writes are switched off (kill switch). To allow changes, set "writesEnabled": true in the plugin config file. Previews still work.');
  }
  const ticket = deps.store.peek(ticketId, 'prepared');
  const p = ticket.payload;
  checkApplyTool(p, sensitiveTool);

  // Re-check the rules now; settings may have been tightened since the preview.
  const live = p.projectId !== undefined && deps.config.liveProjects.includes(p.projectId);
  const verdict = classify(p.action, { projectId: p.projectId, live, features: deps.config.features, params: p.params });
  if (verdict.tier === 3) throw new Error(`Blocked: ${verdict.reason}`);
  if (verdict.sensitive !== p.sensitive || live !== p.live) {
    throw new Error('The rules changed since the preview. Prepare the change again.');
  }
  checkRecipeUnchanged(p, deps);

  if (p.mode === 'console') {
    deps.store.setState(ticketId, 'approved');
    deps.store.extend(ticketId);
    return { consolePlan: consolePlan(p.action, p.projectId, p.params), next: NEXT_CONSOLE };
  }

  deps.store.setState(ticketId, 'failed'); // single use, even if the work below fails
  if (p.mode === 'gcloud') {
    await deps.gcloud.enableService(p.projectId, p.params.api);
    deps.store.setState(ticketId, 'recorded');
    return { applied: true, action: p.action, projectId: p.projectId, api: p.params.api };
  }
  if (p.action === 'save_recipe') {
    const file = deps.recipes.saveRecipe(p.recipeSnapshot);
    deps.store.setState(ticketId, 'recorded');
    return { applied: true, action: p.action, recipe: p.recipeSnapshot.name, file };
  }
  // local: sign in an account. No tokens are ever returned from here.
  const recipe = p.recipeSnapshot;
  const r = await deps.signIn.signInAccount({
    recipe, email: p.params.email, accountType: p.params.accountType, note: p.params.note,
  });
  if (!r || r.ok === false) throw new Error(`Sign-in did not finish: ${(r && r.message) || 'no details'}`);
  deps.store.setState(ticketId, 'recorded');
  return { applied: true, action: p.action, ok: true, tokenFile: r.tokenFile, message: r.message };
}

// ---- record a console result ------------------------------------------------

export async function recordConsoleResult({ ticketId, observed, downloadedFile } = {}, deps) {
  const ticket = deps.store.peek(ticketId, 'approved');
  const p = ticket.payload;
  checkRecipeUnchanged(p, deps);
  deps.store.setState(ticketId, 'recorded'); // recorded either way; a mismatch is reported, not retried
  const { match, differences } = compareObservation(p.expected, observed);
  const out = { match, differences };
  if (p.action === 'create_client' && downloadedFile) {
    if (!match) {
      // Never install a file for a client the console did not show.
      out.installSkipped = 'The console did not show the expected client, so the downloaded file was not installed. Fix the mismatch and record again with a new ticket.';
      return out;
    }
    try {
      const recipe = p.recipeSnapshot;
      const r = await deps.signIn.installClientFile({
        downloadedFile, recipe, allowOverwrite: Boolean(p.params.allowOverwrite),
      });
      out.installed = { installedTo: r.installedTo, clientId: r.clientId };
    } catch (err) {
      out.installError = err.message; // the verdict above is still returned
    }
  }
  return out;
}

// ---- convenience ------------------------------------------------------------

export function createEngine(deps) {
  const store = new TicketStore({ now: deps.now });
  const all = { ...deps, store };
  return {
    store,
    prepareChange: (args) => prepareChange(args, all),
    applyChange: (args) => applyChange(args, all),
    recordConsoleResult: (args) => recordConsoleResult(args, all),
  };
}
