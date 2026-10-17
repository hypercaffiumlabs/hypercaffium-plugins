import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, TicketStore, prepareChange, applyChange, recordConsoleResult, createEngine } from './writes.js';

const P = 'my-project-123';
const ALL_ON = {
  apis: true, projects: true, testUsers: true, branding: true, scopes: true, clients: true, signIns: true,
  publishing: true, liveProjects: true, destructive: true,
};
const RECIPE = { name: 'r1', clientType: 'desktop', clientFile: '{home}/tool/client.json' };

function makeDeps(over = {}) {
  const clock = { t: 1_000_000 };
  const calls = { enable: [], create: [], signIn: [], install: [] };
  const deps = {
    config: { writesEnabled: true, liveProjects: [], features: { ...ALL_ON }, ...over.config },
    gcloud: {
      enabledServices: async () => over.enabled || [],
      enableService: async (project, api) => {
        calls.enable.push([project, api]);
        if (over.enableFails) throw new Error('gcloud exploded');
      },
      listProjects: async () => over.projects || [],
      createProject: async (args) => {
        calls.create.push(args);
        if (over.createFails) throw new Error('That project id is already taken.');
      },
      describeProject: async (id) => {
        if (over.describeFails) throw new Error('not visible yet');
        return { projectId: id, name: 'x', state: 'ACTIVE', parent: null };
      },
    },
    signIn: {
      signInAccount: async (args) => { calls.signIn.push(args); return { ok: true, tokenFile: '/t.json', message: 'signed in' }; },
      installClientFile: async (args) => { calls.install.push(args); return { installedTo: '/c.json', clientId: 'abc.apps' }; },
    },
    recipes: { getRecipe: (n) => { if (n !== 'r1') throw new Error(`Recipe "${n}" was not found`); return RECIPE; } },
    home: '/h',
    fs: { existsSync: (f) => (over.existing || []).includes(f) },
    now: () => clock.t,
  };
  const engine = createEngine(deps);
  return { engine, deps, clock, calls };
}

// ---- classify ----

test('classify: switched-off feature is tier 3', () => {
  const v = classify('publish', { projectId: P, live: false, features: { ...ALL_ON, publishing: false } });
  assert.equal(v.tier, 3);
  assert.equal(v.feature, 'publishing');
  assert.match(v.reason, /switched off/);
});

test('classify: destructive is tier 2 and sensitive; others are not', () => {
  const d = classify('delete_client', { projectId: P, live: false, features: ALL_ON });
  assert.equal(d.tier, 2);
  assert.equal(d.sensitive, true);
  const n = classify('add_test_user', { projectId: P, live: false, features: ALL_ON });
  assert.equal(n.tier, 2);
  assert.equal(n.sensitive, false);
});

test('classify: live project needs the liveProjects feature', () => {
  assert.equal(classify('enable_api', { projectId: P, live: true, features: { ...ALL_ON, liveProjects: false } }).tier, 3);
  const on = classify('enable_api', { projectId: P, live: true, features: ALL_ON });
  assert.equal(on.tier, 2);
  assert.equal(on.live, true);
  assert.ok(on.reason.startsWith('LIVE PROJECT: real users sign in with this'));
});

test('classify: unknown action lists valid ones', () => {
  assert.throws(() => classify('nope', { features: ALL_ON }), /Valid actions: .*enable_api/);
});

// ---- tickets ----

test('TicketStore: single use and expiry with a fake clock', () => {
  let t = 0;
  const s = new TicketStore({ now: () => t });
  const a = s.create({ x: 1 });
  s.peek(a.id);
  s.setState(a.id, 'recorded');
  assert.throws(() => s.peek(a.id), /already applied/);
  const b = s.create({ x: 2 });
  t = 10 * 60 * 1000 + 1;
  assert.throws(() => s.peek(b.id), /expired/);
  assert.throws(() => s.peek(b.id), /Unknown ticket/);
});

// ---- prepare ----

test('prepare validates projectId first and rejects unknown actions', async () => {
  const { engine } = makeDeps();
  await assert.rejects(engine.prepareChange({ projectId: 'BAD', action: 'nope' }), /projectId/);
  await assert.rejects(engine.prepareChange({ projectId: P, action: 'nope' }), /Valid actions/);
});

test('prepare enable_api: before reflects current state, already-on still gets a ticket', async () => {
  const off = makeDeps();
  const r1 = await off.engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  assert.match(r1.preview.before, /is off/);
  assert.ok(r1.ticket);
  assert.equal(r1.mode, 'gcloud');
  const on = makeDeps({ enabled: ['gmail.googleapis.com'] });
  const r2 = await on.engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  assert.match(r2.preview.before, /already on/);
  assert.ok(r2.ticket);
  assert.match(r2.preview.note, /already on/);
});

test('prepare console action: unread page vs currentObserved, and a console plan', async () => {
  const { engine } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'add_test_user', params: { email: 'a@b.com' } });
  assert.equal(r.preview.before, '(read the page first)');
  assert.ok(r.consolePlan.url.includes('/auth/audience'));
  const r2 = await engine.prepareChange({
    projectId: P, action: 'add_test_user', params: { email: 'a@b.com', currentObserved: { testUsers: [] } },
  });
  assert.match(r2.preview.before, /testUsers/);
});

test('prepare: blocked verdicts issue no ticket', async () => {
  const { engine } = makeDeps({ config: { features: { ...ALL_ON, publishing: false } } });
  const r = await engine.prepareChange({ projectId: P, action: 'publish', params: {} });
  assert.equal(r.blocked, true);
  assert.equal(r.tier, 3);
  assert.equal(r.ticket, undefined);
});

test('prepare: live project with liveProjects off is tier 3; on gives liveWarning', async () => {
  const off = makeDeps({ config: { liveProjects: [P], features: { ...ALL_ON, liveProjects: false } } });
  const r1 = await off.engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  assert.equal(r1.tier, 3);
  assert.equal(r1.live, true);
  const on = makeDeps({ config: { liveProjects: [P] } });
  const r2 = await on.engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  assert.equal(r2.tier, 2);
  assert.ok(r2.liveWarning.startsWith('LIVE PROJECT: real users sign in with this'));
  assert.match(r2.liveWarning, /Before: .*\nAfter: /);
});

test('prepare create_client defaults clientType from the recipe', async () => {
  const { engine } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'My client' } });
  assert.match(r.preview.after, /desktop client named "My client"/);
  assert.equal(r.consolePlan.expected.clientType, 'desktop');
});

// ---- apply ----

test('apply refused when writes are off, ticket stays usable', async () => {
  const { engine, deps, calls } = makeDeps({ config: { writesEnabled: false } });
  const r = await engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /Writes are switched off/);
  assert.equal(calls.enable.length, 0);
  deps.config.writesEnabled = true;
  const done = await engine.applyChange({ ticketId: r.ticket });
  assert.equal(done.applied, true);
});

test('apply gcloud: runs enableService once, second apply refused', async () => {
  const { engine, calls } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  await engine.applyChange({ ticketId: r.ticket });
  assert.deepEqual(calls.enable, [[P, 'gmail.googleapis.com']]);
  assert.equal(engine.store.tickets.get(r.ticket).state, 'recorded');
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /already applied/);
});

test('apply gcloud failure leaves the ticket used', async () => {
  const { engine } = makeDeps({ enableFails: true });
  const r = await engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /gcloud exploded/);
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /already applied/);
});

test('apply: destructive needs the sensitive tool, and the sensitive tool refuses normal tickets', async () => {
  const { engine } = makeDeps();
  const d = await engine.prepareChange({ projectId: P, action: 'delete_client', params: { name: 'old' } });
  assert.equal(d.sensitive, true);
  await assert.rejects(engine.applyChange({ ticketId: d.ticket }), /CRITICAL/);
  const ok = await engine.applyChange({ ticketId: d.ticket, sensitiveTool: true });
  assert.ok(ok.consolePlan);
  const n = await engine.prepareChange({ projectId: P, action: 'add_test_user', params: { email: 'a@b.com' } });
  await assert.rejects(engine.applyChange({ ticketId: n.ticket, sensitiveTool: true }), /only applies critical/);
});

test('apply re-checks rules: feature switched off after preview is refused', async () => {
  const { engine, deps } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'publish', params: {} });
  deps.config.features = { ...ALL_ON, publishing: false };
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /Blocked/);
});

test('apply local sign_in_account delegates to signInAccount', async () => {
  const { engine, calls } = makeDeps();
  const r = await engine.prepareChange({
    projectId: P, action: 'sign_in_account', params: { recipe: 'r1', email: 'me@x.com', accountType: 'personal', note: 'n' },
  });
  const done = await engine.applyChange({ ticketId: r.ticket });
  assert.equal(done.ok, true);
  assert.deepEqual(calls.signIn[0], { recipe: RECIPE, email: 'me@x.com', accountType: 'personal', note: 'n' });
  assert.equal(JSON.stringify(done).includes('refresh'), false);
});

test('apply console: returns plan and moves to approved', async () => {
  const { engine } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'publish', params: {} });
  const done = await engine.applyChange({ ticketId: r.ticket });
  assert.match(done.next, /google_record_console_result/);
  assert.ok(done.consolePlan.steps.length > 0);
  assert.equal(engine.store.tickets.get(r.ticket).state, 'approved');
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /already applied/);
});

test('ticket expiry on apply (fake clock)', async () => {
  const { engine, clock } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } });
  clock.t += 10 * 60 * 1000 + 1;
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /expired/);
});

// ---- record ----

test('record before apply is refused', async () => {
  const { engine } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'publish', params: {} });
  await assert.rejects(engine.recordConsoleResult({ ticketId: r.ticket, observed: {} }), /not been applied/);
});

test('record: match, mismatch with differences, and single use', async () => {
  const { engine } = makeDeps();
  const a = await engine.prepareChange({ projectId: P, action: 'publish', params: {} });
  await engine.applyChange({ ticketId: a.ticket });
  const bad = await engine.recordConsoleResult({ ticketId: a.ticket, observed: { publishingStatus: 'Testing' } });
  assert.equal(bad.match, false);
  assert.match(bad.differences[0], /publishingStatus/);
  await assert.rejects(engine.recordConsoleResult({ ticketId: a.ticket, observed: { publishingStatus: 'In production' } }), /already has a recorded/);

  const b = await engine.prepareChange({ projectId: P, action: 'publish', params: {} });
  await engine.applyChange({ ticketId: b.ticket });
  const good = await engine.recordConsoleResult({ ticketId: b.ticket, observed: { publishingStatus: 'In production' } });
  assert.deepEqual(good, { match: true, differences: [] });
});

test('record create_client installs the downloaded file with allowOverwrite from the ticket, no contents in output', async () => {
  const { engine, calls } = makeDeps();
  const r = await engine.prepareChange({
    projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'My client', allowOverwrite: true },
  });
  await engine.applyChange({ ticketId: r.ticket, sensitiveTool: true });
  const out = await engine.recordConsoleResult({
    ticketId: r.ticket, observed: { clients: [{ name: 'My client', type: 'Desktop' }] }, downloadedFile: '/dl/client_secret.json',
  });
  assert.equal(out.match, true);
  assert.deepEqual(out.installed, { installedTo: '/c.json', clientId: 'abc.apps' });
  assert.deepEqual(calls.install[0], { downloadedFile: '/dl/client_secret.json', recipe: RECIPE, allowOverwrite: true });
  assert.equal(JSON.stringify(out).includes('secret'), false);
});

test('record create_client on mismatch is still recorded and does not install without a file', async () => {
  const { engine, calls } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'C' } });
  await engine.applyChange({ ticketId: r.ticket });
  const out = await engine.recordConsoleResult({ ticketId: r.ticket, observed: { clients: [] } });
  assert.equal(out.match, false);
  assert.equal(out.installed, undefined);
  assert.equal(calls.install.length, 0);
  assert.equal(engine.store.tickets.get(r.ticket).state, 'recorded');
});

test('prepareChange and applyChange also work with deps passed directly', async () => {
  const { deps } = makeDeps();
  const store = new TicketStore({ now: deps.now });
  const d = { ...deps, store };
  const r = await prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com' } }, d);
  assert.equal((await applyChange({ ticketId: r.ticket }, d)).applied, true);
  await assert.rejects(recordConsoleResult({ ticketId: r.ticket, observed: {} }, d), /already has a recorded/);
});

// ---- fix round 1 ----

const OBS_OK = { clients: [{ name: 'My client', type: 'Desktop' }] };

test('record: installClientFile throwing still returns the verdict', async () => {
  const { engine, deps } = makeDeps();
  deps.signIn.installClientFile = async () => { throw new Error('file already exists'); };
  const r = await engine.prepareChange({ projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'My client' } });
  await engine.applyChange({ ticketId: r.ticket });
  const out = await engine.recordConsoleResult({ ticketId: r.ticket, observed: OBS_OK, downloadedFile: '/dl/x.json' });
  assert.equal(out.match, true);
  assert.equal(out.installError, 'file already exists');
  assert.equal(out.installed, undefined);
  assert.equal(engine.store.tickets.get(r.ticket).state, 'recorded');
});

test('record: mismatch with a downloaded file skips the install', async () => {
  const { engine, calls } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'My client' } });
  await engine.applyChange({ ticketId: r.ticket });
  const out = await engine.recordConsoleResult({ ticketId: r.ticket, observed: { clients: [] }, downloadedFile: '/dl/x.json' });
  assert.equal(out.match, false);
  assert.ok(out.differences.length > 0);
  assert.match(out.installSkipped, /was not installed/);
  assert.equal(calls.install.length, 0);
});

test('allowOverwrite: preview says OVERWRITE, normal apply refuses, sensitive apply accepts', async () => {
  const { engine } = makeDeps();
  const r = await engine.prepareChange({
    projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'My client', allowOverwrite: true },
  });
  assert.equal(r.feature, 'clients');
  assert.equal(r.sensitive, true);
  assert.match(r.preview.after, /OVERWRITE the existing client file at/);
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /CRITICAL/);
  const ok = await engine.applyChange({ ticketId: r.ticket, sensitiveTool: true });
  assert.ok(ok.consolePlan);
  const plain = await engine.prepareChange({ projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'My client' } });
  assert.equal(plain.sensitive, undefined);
  assert.doesNotMatch(plain.preview.after, /OVERWRITE/);
});

test('create_client: refuses when the client file already exists unless allowOverwrite, and expands {home}', async () => {
  const { engine } = makeDeps({ existing: ['/h/tool/client.json'] });
  await assert.rejects(
    engine.prepareChange({ projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'C' } }),
    /already has a client file at \/h\/tool\/client\.json.*allowOverwrite: true.*google_apply_sensitive_change/,
  );
  const ok = await engine.prepareChange({ projectId: P, action: 'create_client', params: { recipe: 'r1', name: 'C', allowOverwrite: true } });
  assert.match(ok.preview.after, /OVERWRITE the existing client file at \/h\/tool\/client\.json/);
  assert.doesNotMatch(ok.preview.after, /\{home\}/);
});

test('sign_in_account and add_test_user: strict email check', async () => {
  const { engine } = makeDeps();
  for (const email of ['a@b.com; rm', 'a b@c.com', 'a@bxcom']) {
    await assert.rejects(engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { recipe: 'r1', email } }), /email/);
    await assert.rejects(engine.prepareChange({ projectId: P, action: 'add_test_user', params: { email } }), /email/);
  }
});

test('sign_in_account: bad note or accountType rejected, good ones shown in the preview', async () => {
  const { engine } = makeDeps();
  const base = { recipe: 'r1', email: 'me@x.com' };
  await assert.rejects(engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { ...base, note: 'say "hi"' } }), /note/);
  await assert.rejects(engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { ...base, note: 'a{b}' } }), /note/);
  await assert.rejects(engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { ...base, note: 'x'.repeat(121) } }), /note/);
  await assert.rejects(engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { ...base, accountType: 'a;b' } }), /accountType/);
  const r = await engine.prepareChange({ projectId: P, action: 'sign_in_account', params: { ...base, accountType: 'work', note: 'main inbox' } });
  assert.match(r.preview.after, /account type work/);
  assert.match(r.preview.after, /note "main inbox"/);
});

test('unknown params are dropped from the stored ticket', async () => {
  const { engine } = makeDeps();
  const r = await engine.prepareChange({ projectId: P, action: 'enable_api', params: { api: 'gmail.googleapis.com', extra: 'x' } });
  assert.deepEqual(engine.store.tickets.get(r.ticket).payload.params, { api: 'gmail.googleapis.com' });
  const c = await engine.prepareChange({ projectId: P, action: 'publish', params: { currentObserved: { a: 1 }, sneaky: 1 } });
  assert.deepEqual(engine.store.tickets.get(c.ticket).payload.params, {});
  assert.match(c.preview.before, /"a":1/);
});

// ---- create_project ----

const NEW = 'brand-new-tool-1';

test('create_project: preview names the place and the no-billing note', async () => {
  const { engine } = makeDeps();
  const r = await engine.prepareChange({ projectId: NEW, action: 'create_project', params: { name: 'my-tool', organization: '123456789012' } });
  assert.equal(r.mode, 'gcloud');
  assert.equal(r.feature, 'projects');
  assert.match(r.preview.before, /no project with the id brand-new-tool-1/);
  assert.match(r.preview.after, /"my-tool" with the id brand-new-tool-1 exists, inside the organization 123456789012/);
  assert.match(r.preview.note, /No billing account is linked/);
  const bare = await engine.prepareChange({ projectId: NEW, action: 'create_project' });
  assert.match(bare.preview.after, /stands alone/);
});

test('create_project: refuses an id you already have, bad names and bad parents', async () => {
  const mine = makeDeps({ projects: [{ projectId: NEW, name: 'x' }] });
  await assert.rejects(mine.engine.prepareChange({ projectId: NEW, action: 'create_project' }), /already have a project/);
  const { engine } = makeDeps();
  await assert.rejects(engine.prepareChange({ projectId: NEW, action: 'create_project', params: { name: 'has space' } }), /no spaces/);
  await assert.rejects(engine.prepareChange({ projectId: NEW, action: 'create_project', params: { organization: '1', folder: '2' } }), /not both/);
  await assert.rejects(engine.prepareChange({ projectId: NEW, action: 'create_project', params: { folder: 'abc' } }), /numeric id/);
});

test('create_project: switched off is blocked with no ticket', async () => {
  const { engine } = makeDeps({ config: { features: { ...ALL_ON, projects: false } } });
  const r = await engine.prepareChange({ projectId: NEW, action: 'create_project' });
  assert.equal(r.blocked, true);
  assert.equal(r.ticket, undefined);
});

test('create_project: apply creates once and reads the project back', async () => {
  const { engine, calls } = makeDeps();
  const r = await engine.prepareChange({ projectId: NEW, action: 'create_project', params: { name: 'my-tool', folder: '42' } });
  const out = await engine.applyChange({ ticketId: r.ticket });
  assert.deepEqual(calls.create, [{ projectId: NEW, name: 'my-tool', organization: undefined, folder: '42' }]);
  assert.equal(out.verified, true);
  assert.equal(out.project.state, 'ACTIVE');
  await assert.rejects(engine.applyChange({ ticketId: r.ticket }), /already applied/);
  assert.equal(calls.create.length, 1);
});

test('create_project: a failed create uses the ticket; a failed read-back says so', async () => {
  const bad = makeDeps({ createFails: true });
  const r = await bad.engine.prepareChange({ projectId: NEW, action: 'create_project' });
  await assert.rejects(bad.engine.applyChange({ ticketId: r.ticket }), /already taken/);
  await assert.rejects(bad.engine.applyChange({ ticketId: r.ticket }), /already applied/);
  const blind = makeDeps({ describeFails: true });
  const r2 = await blind.engine.prepareChange({ projectId: NEW, action: 'create_project' });
  const out = await blind.engine.applyChange({ ticketId: r2.ticket });
  assert.equal(out.applied, true);
  assert.equal(out.verified, false);
  assert.match(out.verifyError, /reading it back failed/);
});
