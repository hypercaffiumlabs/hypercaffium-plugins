import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipe } from './recipes.js';

const HOME = '/home/tester';
const base = (o = {}) => ({
  name: 'my-tool',
  description: 'A test tool',
  apis: ['drive.googleapis.com'],
  scopes: ['openid'],
  clientType: 'web',
  clientFile: '{home}/my-tool/client.json',
  login: { command: 'my-tool login {email}', cwd: '{home}/my-tool' },
  tokens: { path: '{home}/my-tool/token.{email}.json', refreshTokenField: 'refresh_token' },
  ...o,
});
const problems = (o) => {
  try {
    validateRecipe(base(o), { home: HOME });
  } catch (err) {
    return err.problems;
  }
  return [];
};

test('a recipe inside home validates', () => {
  assert.deepEqual(problems({}), []);
});

test('recipe paths must stay inside home and away from secret folders', () => {
  assert.ok(problems({ clientFile: '/etc/client.json' }).some((m) => /clientFile must be inside/.test(m)));
  assert.ok(problems({ clientFile: '{home}/../other/client.json' }).some((m) => /clientFile/.test(m)));
  assert.ok(problems({ clientFile: '{home}/.ssh/client.json' }).some((m) => /\.ssh/.test(m)));
  assert.ok(problems({ clientFile: '{home}/.config/gcloud/x.json' }).some((m) => /gcloud/.test(m)));
  assert.ok(problems({ tokens: { path: '{home}/.claude/t.{email}.json', refreshTokenField: 'r' } }).some((m) => /tokens\.path/.test(m)));
  assert.ok(problems({ tokens: { path: '{home}/.claude-plugins/t.{email}.json', refreshTokenField: 'r' } }).some((m) => /claude-plugins/.test(m)));
  assert.ok(problems({ login: { command: 'x {email}', cwd: '{home}/.aws' } }).some((m) => /login\.cwd/.test(m)));
  assert.ok(problems({ accountsFile: { path: '{home}/.gnupg/a.json', listKey: 'a', entry: {} } }).some((m) => /accountsFile\.path/.test(m)));
});
