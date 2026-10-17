import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installClientFile, addAccount, signInAccount } from './signin.js';

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-'));
  fs.mkdirSync(path.join(home, 'Downloads'));
  fs.mkdirSync(path.join(home, 'tool'));
  const recipe = {
    clientType: 'desktop',
    clientFile: '{home}/tool/.gauth.json',
    accountsFile: { path: '{home}/tool/.accounts.json', listKey: 'accounts', entry: { email: '{email}', account_type: '{accountType}', extra_info: '{note}' } },
    login: { command: 'tool login {email} --force', cwd: '{home}/tool', timeoutSec: 5 },
    tokens: { path: '{home}/tool/.oauth2.{email}.json', refreshTokenField: 'refresh_token' },
  };
  return { home, recipe };
}
const dl = (home, body) => {
  const f = path.join(home, 'Downloads', 'client.json');
  fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
};
const good = { installed: { client_id: 'id1', client_secret: 'SECRET123' } };

test('installs a desktop client file, returns only client id, deletes download, mode 0600', () => {
  const { home, recipe } = setup();
  const f = dl(home, good);
  const r = installClientFile({ downloadedFile: f, recipe }, { home });
  assert.deepEqual(Object.keys(r).sort(), ['clientId', 'installedTo']);
  assert.equal(r.clientId, 'id1');
  assert.equal(fs.existsSync(f), false);
  assert.equal(JSON.parse(fs.readFileSync(r.installedTo, 'utf8')).installed.client_secret, 'SECRET123');
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.installedTo).mode & 0o777, 0o600);
});

test('refuses the wrong shape without leaking contents', () => {
  const { home, recipe } = setup();
  const f = dl(home, { web: { client_id: 'x', client_secret: 'SECRET123' } });
  assert.throws(() => installClientFile({ downloadedFile: f, recipe }, { home }), (e) => !e.message.includes('SECRET123') && /desktop/.test(e.message));
  assert.equal(fs.existsSync(f), true);
});

test('bad JSON error does not contain the secret', () => {
  const { home, recipe } = setup();
  const f = dl(home, '{"installed": SECRET123');
  assert.throws(() => installClientFile({ downloadedFile: f, recipe }, { home }), (e) => !e.message.includes('SECRET123'));
});

test('refuses an existing target unless allowOverwrite', () => {
  const { home, recipe } = setup();
  fs.writeFileSync(path.join(home, 'tool', '.gauth.json'), 'old');
  const f = dl(home, good);
  assert.throws(() => installClientFile({ downloadedFile: f, recipe }, { home }), (e) => !e.message.includes('SECRET123'));
  assert.equal(fs.readFileSync(path.join(home, 'tool', '.gauth.json'), 'utf8'), 'old');
  installClientFile({ downloadedFile: f, recipe, allowOverwrite: true }, { home });
  assert.match(fs.readFileSync(path.join(home, 'tool', '.gauth.json'), 'utf8'), /id1/);
});

test('refuses files outside Downloads, non-strings and network paths', () => {
  const { home, recipe } = setup();
  const outside = path.join(home, 'tool', 'c.json');
  fs.writeFileSync(outside, JSON.stringify(good));
  assert.throws(() => installClientFile({ downloadedFile: outside, recipe }, { home }), /Downloads/);
  assert.throws(() => installClientFile({ downloadedFile: 42, recipe }, { home }));
  assert.throws(() => installClientFile({ downloadedFile: '\\\\server\\share\\c.json', recipe }, { home }), /Network/);
  assert.throws(() => installClientFile({ downloadedFile: '//server/share/c.json', recipe }, { home }), /Network/);
  assert.throws(() => installClientFile({ downloadedFile: path.join(home, 'Downloads', '..', 'tool', 'c.json'), recipe }, { home }), /Downloads/);
});

test('addAccount creates the file, keeps other content, and does not duplicate', () => {
  const { home, recipe } = setup();
  const file = path.join(home, 'tool', '.accounts.json');
  addAccount({ recipe, email: 'a@b.com', accountType: 'personal', note: 'hi' }, { home });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accounts, [{ email: 'a@b.com', account_type: 'personal', extra_info: 'hi' }]);
  addAccount({ recipe, email: 'a@b.com' }, { home });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accounts.length, 1);
  fs.writeFileSync(file, JSON.stringify({ other: 1, accounts: [] }, null, 2));
  addAccount({ recipe, email: 'c@d.org' }, { home });
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.other, 1);
  assert.equal(doc.accounts.length, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /\n {2}"other"/);
});

test('bad emails, types and notes are rejected before any spawn or write', async () => {
  const { home, recipe } = setup();
  let spawned = 0;
  const spawn = () => { spawned++; throw new Error('no'); };
  for (const email of ['a@b.com; rm', 'a b@c.com', 'a@b.c', 'x"@b.com', 'a@b.com\n']) {
    await assert.rejects(signInAccount({ recipe, email }, { home, spawn, platform: 'linux' }));
  }
  await assert.rejects(signInAccount({ recipe, email: 'a@b.com', accountType: 'x;y' }, { home, spawn }));
  await assert.rejects(signInAccount({ recipe, email: 'a@b.com', note: 'a$b' }, { home, spawn }));
  await assert.rejects(signInAccount({ recipe, email: 'a@b.com', note: 'a\u0001b' }, { home, spawn }));
  assert.equal(spawned, 0);
  assert.equal(fs.existsSync(path.join(home, 'tool', '.accounts.json')), false);
});

function fakeSpawn(home, { write = true, code = 0, hang = false } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const handlers = {};
    const child = {
      on: (n, f) => { handlers[n] = f; },
      kill() { setImmediate(() => handlers.close(null)); },
    };
    if (!hang) {
      setImmediate(() => {
        if (write) fs.writeFileSync(path.join(home, 'tool', '.oauth2.a@b.com.json'), JSON.stringify({ refresh_token: 'RT-SECRET' }));
        handlers.close(code);
      });
    }
    return child;
  };
  return { spawn, calls };
}

test('login succeeds only when the token file has the refresh token; token not returned', async () => {
  const { home, recipe } = setup();
  const f = fakeSpawn(home);
  const r = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn: f.spawn, platform: 'linux' });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(r).includes('RT-SECRET'));
  assert.equal(f.calls[0].cmd, 'tool');
  assert.deepEqual(f.calls[0].args, ['login', 'a@b.com', '--force']);
  assert.equal(f.calls[0].opts.shell, false);
});

test('on Windows the command goes through cmd.exe without a shell option', async () => {
  const { home, recipe } = setup();
  const f = fakeSpawn(home);
  const r = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn: f.spawn, platform: 'win32' });
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].cmd, 'cmd.exe');
  assert.deepEqual(f.calls[0].args.slice(0, 4), ['/d', '/s', '/c', 'tool']);
  assert.equal(f.calls[0].opts.shell, false);
});

test('login without a token file, or with a nonzero exit, is not ok', async () => {
  const { home, recipe } = setup();
  const r1 = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn: fakeSpawn(home, { write: false }).spawn, platform: 'linux' });
  assert.equal(r1.ok, false);
  const r2 = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn: fakeSpawn(home, { code: 1 }).spawn, platform: 'linux' });
  assert.equal(r2.ok, false);
});

test('a stale token file does not count as success', async () => {
  const { home, recipe } = setup();
  fs.writeFileSync(path.join(home, 'tool', '.oauth2.a@b.com.json'), JSON.stringify({ refresh_token: 'old' }));
  const r = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn: fakeSpawn(home, { write: false }).spawn, platform: 'linux' });
  assert.equal(r.ok, false);
});

test('timeout kills the process and reports plainly', async () => {
  const { home, recipe } = setup();
  recipe.login.timeoutSec = 0.05;
  const r = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn: fakeSpawn(home, { hang: true }).spawn, platform: 'linux' });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not finish within/);
});

test('rejects quotes in the command and token paths outside allowed folders', async () => {
  const { home, recipe } = setup();
  const spawn = () => { throw new Error('should not spawn'); };
  await assert.rejects(signInAccount({ recipe: { ...recipe, login: { ...recipe.login, command: 'tool "x" {email}' } }, email: 'a@b.com' }, { home, spawn }));
  await assert.rejects(signInAccount({ recipe: { ...recipe, tokens: { ...recipe.tokens, path: '/etc/{email}.json' } }, email: 'a@b.com' }, { home, spawn }));
});

test('timeout resolves even if the child never emits close', async () => {
  const { home, recipe } = setup();
  recipe.login.timeoutSec = 0.05;
  const kills = [];
  const spawn = () => ({ pid: 4242, on() {}, kill(sig) { kills.push(sig); } });
  const r = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn, platform: 'linux' });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not finish within/);
  assert.deepEqual(kills, ['SIGTERM']);
});

test('on Windows the timeout ends the whole tree with taskkill /T /F /PID', async () => {
  const { home, recipe } = setup();
  recipe.login.timeoutSec = 0.05;
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 4242, on() {}, kill() {} }; };
  const r = await signInAccount({ recipe, email: 'a@b.com' }, { home, spawn, platform: 'win32' });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not finish within/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cmd, 'taskkill');
  assert.deepEqual(calls[1].args, ['/T', '/F', '/PID', '4242']);
  assert.equal(calls[1].opts.shell, false);
});
