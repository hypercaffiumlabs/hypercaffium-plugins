import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPECTED_TOOLS = [
  'google_check_setup', 'google_settings', 'google_save_settings', 'google_list_projects', 'google_list_organizations', 'google_project_status',
  'google_list_recipes', 'google_console_page', 'google_check_accounts', 'google_evaluate_console',
  'google_audit_log', 'google_prepare_change', 'google_apply_change', 'google_apply_sensitive_change',
  'google_record_console_result',
];

// Spawns a server entry (default: the source file) over stdio with an empty fake home.
export function startServer(entry = fileURLToPath(new URL('./index.js', import.meta.url))) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-srv-'));
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      USERPROFILE: path.join(tmp, 'home'),
      HOME: path.join(tmp, 'home'),
      HYPERCAFFIUM_GOOGLE_OAUTH_CONFIG: path.join(tmp, 'settings.json'),
      GOOGLE_OAUTH_WRITES_ENABLED: '',
      CLAUDE_PLUGINS_AUDIT_DIR: path.join(tmp, 'audit'),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) replies.set(msg.id, msg);
      }
    }
  });
  const request = async (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let n = 0; n < 200 && !replies.has(id); n++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(replies.has(id), `no reply to ${method}`);
    return replies.get(id).result;
  };
  return {
    tmp,
    async init() {
      await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    tools: async () => (await request('tools/list')).tools,
    call: async (name, args = {}) => {
      const r = await request('tools/call', { name, arguments: args });
      return { isError: Boolean(r.isError), text: r.content[0].text };
    },
    close: () => child.kill(),
  };
}

test('server: lists all 15 tools and read tools are marked read-only', async () => {
  const s = startServer();
  try {
    await s.init();
    const tools = await s.tools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    const CHANGING = new Set(['google_save_settings', 'google_apply_change', 'google_apply_sensitive_change', 'google_record_console_result']);
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, !CHANGING.has(t.name), `${t.name} read-only annotation`);
      assert.ok(!t.description.includes(String.fromCharCode(0x2014)), `${t.name} description has an em dash`);
    }
    assert.match(tools.find((t) => t.name === 'google_prepare_change').description, /STEP 1/);
    assert.match(tools.find((t) => t.name === 'google_apply_change').description, /STEP 2/);
  } finally {
    s.close();
  }
});

test('server: prepare previews with writes off, apply is refused, unknown action lists the valid ones', async () => {
  const s = startServer();
  try {
    await s.init();
    const prep = await s.call('google_prepare_change', { projectId: 'my-app-123456', action: 'add_test_user', params: { email: 'a@example.com' } });
    assert.equal(prep.isError, false, prep.text);
    const p = JSON.parse(prep.text);
    assert.equal(p.writesEnabled, false);
    assert.ok(p.ticket);
    assert.equal(p.mode, 'console');

    const apply = await s.call('google_apply_change', { ticket: p.ticket });
    assert.equal(apply.isError, true);
    assert.match(apply.text, /switched off/);

    const bad = await s.call('google_prepare_change', { projectId: 'my-app-123456', action: 'explode' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Valid actions: .*enable_api.*publish/);
  } finally {
    s.close();
  }
});

test('server: settings can be saved, critical features cannot be switched on, calls are audited', async () => {
  const s = startServer();
  try {
    await s.init();
    const saved = await s.call('google_save_settings', { writesEnabled: true, liveProjects: ['live-proj-123'] });
    assert.equal(saved.isError, false, saved.text);
    assert.equal(JSON.parse(saved.text).writesEnabled, true);
    // settings are read fresh on every call
    assert.equal(JSON.parse((await s.call('google_settings')).text).writesEnabled, true);
    const crit = await s.call('google_save_settings', { features: { destructive: true } });
    assert.equal(crit.isError, true);
    assert.match(crit.text, /critical/);
    const check = JSON.parse((await s.call('google_check_setup')).text);
    assert.ok('gcloud' in check && check.kapture.includes('Kapture'));
    const log = await s.call('google_audit_log', { limit: 10 });
    assert.match(log.text, /google_save_settings/);
    assert.match(log.text, /"ok": false/);
  } finally {
    s.close();
  }
});

test('server: built-in recipe is found', async () => {
  const s = startServer();
  try {
    await s.init();
    assert.match((await s.call('google_list_recipes')).text, /mcp-google-workspace/);
    const page = JSON.parse((await s.call('google_console_page', { projectId: 'my-app-123456', page: 'audience' })).text);
    assert.match(page.url, /project=my-app-123456/);
    assert.ok(page.labels.includes('Publishing status'));
  } finally {
    s.close();
  }
});

// The shipped bundle (built by npm run build) must behave the same; skipped when not built yet.
const BUNDLE = fileURLToPath(new URL('./dist/server.mjs', import.meta.url));
test('bundle: dist/server.mjs lists 15 tools and finds the built-in recipe', { skip: !fs.existsSync(BUNDLE) }, async () => {
  const s = startServer(BUNDLE);
  try {
    await s.init();
    assert.equal((await s.tools()).length, 15);
    assert.match((await s.call('google_list_recipes')).text, /mcp-google-workspace/);
  } finally {
    s.close();
  }
});

test('server: gcloudPath cannot be set from chat and live projects can only be added', async () => {
  const s = startServer();
  try {
    await s.init();
    const file = () => JSON.parse(fs.readFileSync(path.join(s.tmp, 'settings.json'), 'utf8'));
    await s.call('google_save_settings', { gcloudPath: 'C:\evil\gcloud.cmd', liveProjects: ['live-proj-123'] });
    assert.equal(file().gcloudPath, undefined);
    assert.deepEqual(file().liveProjects, ['live-proj-123']);
    const dropped = await s.call('google_save_settings', { liveProjects: ['other-proj-456'] });
    assert.equal(dropped.isError, true);
    assert.match(dropped.text, /Removing a live project/);
    const added = await s.call('google_save_settings', { liveProjects: ['live-proj-123', 'other-proj-456'] });
    assert.equal(added.isError, false, added.text);
    assert.deepEqual(file().liveProjects, ['live-proj-123', 'other-proj-456']);
  } finally {
    s.close();
  }
});

test('server: saving a recipe needs a ticket', async () => {
  const s = startServer();
  try {
    await s.init();
    fs.writeFileSync(path.join(s.tmp, 'settings.json'), JSON.stringify({ writesEnabled: true }));
    const recipe = {
      name: 'my-tool', description: 'd', apis: ['drive.googleapis.com'], scopes: ['openid'], clientType: 'web',
      clientFile: '{home}/my-tool/client.json',
      login: { command: 'my-tool login {email}', cwd: '{home}/my-tool' },
      tokens: { path: '{home}/my-tool/token.{email}.json', refreshTokenField: 'refresh_token' },
    };
    const prep = JSON.parse((await s.call('google_prepare_change', { action: 'save_recipe', params: { recipe } })).text);
    assert.match(prep.preview.details.loginCommand, /my-tool login \{email\}/);
    assert.doesNotMatch((await s.call('google_list_recipes')).text, /"my-tool"/);
    const applied = await s.call('google_apply_change', { ticket: prep.ticket });
    assert.equal(applied.isError, false, applied.text);
    assert.match((await s.call('google_list_recipes')).text, /"my-tool"/);
  } finally {
    s.close();
  }
});

test('server: end to end change flow, and a ticket works only once', async () => {
  const s = startServer();
  try {
    await s.init();
    fs.writeFileSync(path.join(s.tmp, 'settings.json'), JSON.stringify({ writesEnabled: true }));
    const prep = JSON.parse((await s.call('google_prepare_change', { projectId: 'my-app-123456', action: 'add_test_user', params: { email: 'a@example.com' } })).text);
    assert.equal(prep.writesEnabled, true);
    const applied = JSON.parse((await s.call('google_apply_change', { ticket: prep.ticket })).text);
    assert.ok(applied.consolePlan && applied.next);
    const rec = await s.call('google_record_console_result', { ticket: prep.ticket, observed: { testUsers: ['a@example.com'] } });
    assert.equal(rec.isError, false, rec.text);
    assert.equal(JSON.parse(rec.text).match, true);
    const again = await s.call('google_apply_change', { ticket: prep.ticket });
    assert.equal(again.isError, true);
    assert.match(again.text, /already applied|Tickets work once/);
  } finally {
    s.close();
  }
});
