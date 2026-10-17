import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';
import { listRecipes, getRecipe, saveRecipe, validateRecipe, expand } from './recipes.js';

let dir;
let home;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcgo-recipes-'));
  home = path.join(dir, 'fake-home');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ dir: path.join(dir, 'recipes'), home });

function userRecipe(overrides = {}) {
  return {
    name: 'my-tool',
    description: 'A test tool',
    apis: ['drive.googleapis.com'],
    scopes: ['openid', 'https://www.googleapis.com/auth/drive.readonly'],
    clientType: 'web',
    clientFile: '{home}/my-tool/client.json',
    login: { command: 'my-tool login {email}', cwd: '{home}/my-tool', timeoutSec: 120 },
    tokens: { path: '{home}/my-tool/token.{email}.json', refreshTokenField: 'refresh_token' },
    ...overrides,
  };
}

function problemsOf(obj) {
  try {
    validateRecipe(obj);
  } catch (err) {
    return err.problems;
  }
  return null;
}

test('the built-in mcp-google-workspace recipe validates and is listed first', () => {
  const recipes = listRecipes(opts());
  assert.equal(recipes[0].name, 'mcp-google-workspace');
  const builtin = recipes[0];
  assert.deepEqual(builtin.apis, ['gmail.googleapis.com', 'calendar-json.googleapis.com']);
  assert.deepEqual(builtin.scopes, [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.settings.basic',
    'https://www.googleapis.com/auth/calendar.events',
  ]);
  assert.equal(builtin.clientType, 'desktop');
  assert.equal(builtin.clientFile, '{home}/mcp-google-workspace/.gauth.json');
  assert.deepEqual(builtin.accountsFile, {
    path: '{home}/mcp-google-workspace/.accounts.json',
    listKey: 'accounts',
    entry: { email: '{email}', account_type: '{accountType}', extra_info: '{note}' },
  });
  assert.deepEqual(builtin.login, {
    command: 'npm run authenticate -- {email} --force',
    cwd: '{home}/mcp-google-workspace',
    timeoutSec: 300,
  });
  assert.deepEqual(builtin.tokens, {
    path: '{home}/mcp-google-workspace/.oauth2.{email}.json',
    refreshTokenField: 'refresh_token',
  });
  assert.equal(problemsOf(builtin), null);
});

test('a login command without {email} is rejected', () => {
  const problems = problemsOf(userRecipe({ login: { command: 'my-tool login' } }));
  assert.ok(problems.some((p) => /login\.command/.test(p) && /\{email\}/.test(p)), problems.join('\n'));
});

test('a tokens path without {email} is rejected', () => {
  const problems = problemsOf(userRecipe({ tokens: { path: '{home}/token.json', refreshTokenField: 'refresh_token' } }));
  assert.ok(problems.some((p) => /tokens\.path/.test(p)), problems.join('\n'));
});

test('an unknown clientType is rejected', () => {
  const problems = problemsOf(userRecipe({ clientType: 'installed' }));
  assert.ok(problems.some((p) => /clientType/.test(p)), problems.join('\n'));
});

test('a bad name is rejected', () => {
  const problems = problemsOf(userRecipe({ name: 'Bad Name!' }));
  assert.ok(problems.some((p) => /name/.test(p)), problems.join('\n'));
});

test('validation reports every problem at once as a list', () => {
  const problems = problemsOf(userRecipe({ clientType: 'nope', login: { command: 'x' } }));
  assert.ok(Array.isArray(problems));
  assert.ok(problems.length >= 2);
});

test('saveRecipe refuses the built-in name', () => {
  assert.throws(
    () => saveRecipe(userRecipe({ name: 'mcp-google-workspace' }), opts()),
    /built-in/i,
  );
  assert.equal(fs.existsSync(path.join(dir, 'recipes', 'mcp-google-workspace.json')), false);
});

test('a user recipe round-trips through saveRecipe and getRecipe', () => {
  const recipe = userRecipe();
  const file = saveRecipe(recipe, opts());
  assert.equal(file, path.join(dir, 'recipes', 'my-tool.json'));
  assert.deepEqual(getRecipe('my-tool', opts()), recipe);
});

test('user recipes come after the built-ins in listRecipes', () => {
  saveRecipe(userRecipe(), opts());
  const names = listRecipes(opts()).map((r) => r.name);
  assert.deepEqual(names, ['mcp-google-workspace', 'my-tool']);
});

test('getRecipe throws for an unknown name', () => {
  assert.throws(() => getRecipe('nothing-here', opts()), /not found/i);
});

test('getRecipe returns placeholders unexpanded', () => {
  const recipe = getRecipe('mcp-google-workspace', opts());
  assert.equal(recipe.clientFile, '{home}/mcp-google-workspace/.gauth.json');
});

test('expand substitutes known placeholders and leaves unknown ones alone', () => {
  const out = expand('{home}/x/{email}/{unknown}', { home: '/h', email: 'a@b.com' });
  assert.equal(out, '/h/x/a@b.com/{unknown}');
});

test('expand replaces every occurrence of a placeholder', () => {
  assert.equal(expand('{email} and {email}', { email: 'q@q.com' }), 'q@q.com and q@q.com');
});
