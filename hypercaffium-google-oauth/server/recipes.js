// Recipes describe one tool that needs Google sign-in: its APIs, scopes, client file, accounts file,
// how to sign an account in, and where its tokens live. Built-in recipes ship with the plugin;
// user recipes live in RECIPES_DIR. Paths keep {home} placeholders until a caller expands them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPES_DIR } from './config.js';

// Built-in recipes sit next to this module. The bundle copies server/recipes into dist/recipes.
const BUILTIN_DIR = fileURLToPath(new URL('./recipes/', import.meta.url));
// The recipe name becomes a file name, so it is kept to lowercase letters, digits and hyphens.
const NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const API_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.googleapis\.com$/;
const CLIENT_TYPES = ['desktop', 'web'];

// Folders under home that a recipe may never point into (keys, cloud logins, this plugin's own files).
const PROTECTED_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.claude', '.claude-plugins'];
const win = process.platform === 'win32';
const norm = (p) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));

// Returns a problem text when the path (after expanding {home} and a sample {email}) is not a safe place.
function pathProblem(label, template, home, { allowHome = false } = {}) {
  const expanded = expand(template, { home, email: 'x@example.com' });
  const rel = path.relative(norm(home), norm(expanded));
  if (rel === '' ) return allowHome ? null : `${label} must be a file inside your home folder, not the home folder itself`;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `${label} must be inside your home folder`;
  const parts = rel.split(path.sep).join('/');
  for (const d of PROTECTED_DIRS) {
    const dn = win ? d.toLowerCase() : d;
    if (parts === dn || parts.startsWith(`${dn}/`)) return `${label} may not be inside ~/${d}`;
  }
  return null;
}

// A short fingerprint of a recipe, used to notice a recipe changing between preview and apply.
export function recipeHash(recipe) {
  return crypto.createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isStringList = (v) => Array.isArray(v) && v.length > 0 && v.every(isText);

// Checks a recipe object. Returns the recipe when valid; otherwise throws an Error whose
// `problems` property is the full list of what is wrong, so the caller can show them all at once.
export function validateRecipe(obj, { home = os.homedir() } = {}) {
  const problems = [];
  if (!isObject(obj)) {
    throw Object.assign(new Error('Recipe is not valid: it must be an object'), { problems: ['recipe must be an object'] });
  }
  if (typeof obj.name !== 'string' || !NAME.test(obj.name)) {
    problems.push('name must be 2 to 41 lowercase letters, digits or hyphens, starting with a letter or digit');
  }
  if (!isText(obj.description)) problems.push('description must be a non-empty string');
  if (!Array.isArray(obj.apis) || !obj.apis.every((a) => typeof a === 'string' && API_NAME.test(a)) || obj.apis.length === 0) {
    problems.push('apis must be a non-empty list of Google API names such as gmail.googleapis.com');
  }
  if (!isStringList(obj.scopes)) problems.push('scopes must be a non-empty list of strings');
  if (!CLIENT_TYPES.includes(obj.clientType)) problems.push(`clientType must be one of: ${CLIENT_TYPES.join(', ')}`);
  if (!isText(obj.clientFile)) problems.push('clientFile must be a non-empty string');

  if (obj.accountsFile !== undefined) {
    const af = obj.accountsFile;
    if (!isObject(af)) {
      problems.push('accountsFile must be an object');
    } else {
      if (!isText(af.path)) problems.push('accountsFile.path must be a non-empty string');
      if (!isText(af.listKey)) problems.push('accountsFile.listKey must be a non-empty string');
      if (!isObject(af.entry)) problems.push('accountsFile.entry must be an object');
      else if (!Object.values(af.entry).every((v) => typeof v === 'string')) problems.push('accountsFile.entry values must be strings');
    }
  }

  if (!isObject(obj.login)) {
    problems.push('login must be an object');
  } else {
    if (typeof obj.login.command !== 'string' || !obj.login.command.includes('{email}')) {
      problems.push('login.command must be a string that contains {email}');
    }
    if (obj.login.cwd !== undefined && !isText(obj.login.cwd)) problems.push('login.cwd must be a non-empty string');
    if (obj.login.timeoutSec !== undefined && !(Number.isFinite(obj.login.timeoutSec) && obj.login.timeoutSec > 0)) {
      problems.push('login.timeoutSec must be a positive number');
    }
  }

  if (!isObject(obj.tokens)) {
    problems.push('tokens must be an object');
  } else {
    if (typeof obj.tokens.path !== 'string' || !obj.tokens.path.includes('{email}')) {
      problems.push('tokens.path must be a string that contains {email}');
    }
    if (!isText(obj.tokens.refreshTokenField)) problems.push('tokens.refreshTokenField must be a non-empty string');
  }

  // Every file or folder the recipe touches must stay inside the home folder and away from secrets.
  const places = [['clientFile', obj.clientFile], ['accountsFile.path', obj.accountsFile?.path], ['tokens.path', obj.tokens?.path]];
  for (const [label, value] of places) {
    if (isText(value)) {
      const bad = pathProblem(label, value, home);
      if (bad) problems.push(bad);
    }
  }
  if (isText(obj.login?.cwd)) {
    const bad = pathProblem('login.cwd', obj.login.cwd, home, { allowHome: true });
    if (bad) problems.push(bad);
  }

  if (problems.length) {
    throw Object.assign(new Error(`Recipe is not valid: ${problems.join('; ')}`), { problems });
  }
  return obj;
}

function readJsonFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} could not be read as a recipe: ${err.message}`);
  }
  return validateRecipe(parsed);
}

function builtinRecipes() {
  return fs.readdirSync(BUILTIN_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJsonFile(path.join(BUILTIN_DIR, f)));
}

function userRecipes(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJsonFile(path.join(dir, f)));
}

// Built-ins first, then user recipes. A user file that reuses a built-in name is ignored.
// The options object may also carry `home` (a fake home in tests). Recipes are not expanded here,
// so nothing in listing needs it; expansion happens later in expand().
export function listRecipes({ dir = RECIPES_DIR } = {}) {
  const builtins = builtinRecipes();
  const builtinNames = new Set(builtins.map((r) => r.name));
  return [...builtins, ...userRecipes(dir).filter((r) => !builtinNames.has(r.name))];
}

export function isBuiltinRecipe(name) {
  return builtinRecipes().some((r) => r.name === name);
}

export function getRecipe(name, opts = {}) {
  const found = listRecipes(opts).find((r) => r.name === name);
  if (!found) throw new Error(`Recipe "${name}" was not found`);
  return found;
}

// Validates and writes a user recipe to <dir>/<name>.json. Returns the file path.
export function saveRecipe(obj, { dir = RECIPES_DIR } = {}) {
  validateRecipe(obj);
  if (builtinRecipes().some((r) => r.name === obj.name)) {
    throw new Error(`"${obj.name}" is a built-in recipe name and cannot be overwritten`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${obj.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
  return file;
}

// Replaces each {key} that has a value in vars. Unknown placeholders are left untouched.
export function expand(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(vars, key) && typeof vars[key] === 'string' ? vars[key] : match);
}
