import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './writes.js';

const P = 'my-project-123';
const ALL_ON = {
  apis: true, testUsers: true, branding: true, scopes: true, clients: true, signIns: true,
  publishing: true, liveProjects: true, destructive: true,
};
const FULL = {
  name: 'r2', description: 'd', apis: ['gmail.googleapis.com'], scopes: ['openid'], clientType: 'desktop',
  clientFile: '{home}/r2/client.json',
  login: { command: 'r2 login {email}', cwd: '{home}/r2' },
  tokens: { path: '{home}/r2/token.{email}.json', refreshTokenField: 'refresh_token' },
};

function make() {
  const state = { recipe: FULL, signIns: [], saved: [] };
  const engine = createEngine({
    home: '/h',
    config: { writesEnabled: true, liveProjects: [], features: { ...ALL_ON } },
    gcloud: { enabledServices: async () => [], enableService: async () => {} },
    signIn: {
      signInAccount: async (a) => { state.signIns.push(a); return { ok: true, tokenFile: '/t.json', message: 'ok' }; },
      installClientFile: async () => ({ installedTo: '/c.json', clientId: 'x' }),
    },
    recipes: {
      getRecipe: (n) => { if (n !== 'r2') throw new Error('not found'); return state.recipe; },
      saveRecipe: (r) => { state.saved.push(r); return '/f.json'; },
      isBuiltin: (n) => n === 'builtin-one',
    },
  });
  return { engine, state };
}

test('sign_in_account preview shows the exact login command and working folder', async () => {
  const { engine } = make();
  const r = await engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { recipe: 'r2', email: 'me@x.com' } });
  assert.equal(r.preview.details.loginCommand, 'r2 login me@x.com');
  assert.match(r.preview.details.loginCwd.replace(/\\/g, '/'), /\/h\/r2$/);
  assert.match(r.preview.details.tokensPath.replace(/\\/g, '/'), /\/h\/r2\/token\.me@x\.com\.json$/);
});

test('a recipe that changes between prepare and apply is refused', async () => {
  const { engine, state } = make();
  const r = await engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { recipe: 'r2', email: 'me@x.com' } });
  state.recipe = { ...FULL, login: { command: 'evil {email}', cwd: '{home}/r2' } };
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /changed since the preview/);
  assert.equal(state.signIns.length, 0);
});

test('save_recipe is ticketed: preview shows the places, apply saves the snapshot once', async () => {
  const { engine, state } = make();
  const r = await engine.prepareChange({ action: 'save_recipe', params: { recipe: FULL } });
  assert.equal(r.tier, 2);
  assert.equal(r.preview.details.loginCommand, 'r2 login {email}');
  assert.ok(r.preview.details.tokensPath.includes('{email}'));
  assert.equal(state.saved.length, 0);
  const a = await engine.applyChange({ ticketId: r.ticket });
  assert.equal(a.applied, true);
  assert.deepEqual(state.saved, [FULL]);
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /already applied/);
});

test('save_recipe refuses unsafe recipes and built-in names at prepare time', async () => {
  const { engine } = make();
  await assert.rejects(engine.prepareChange({ action: 'save_recipe', params: { recipe: { ...FULL, clientFile: '/etc/passwd' } } }), /clientFile/);
  await assert.rejects(engine.prepareChange({ action: 'save_recipe', params: { recipe: { ...FULL, name: 'builtin-one' } } }), /built-in/);
});
