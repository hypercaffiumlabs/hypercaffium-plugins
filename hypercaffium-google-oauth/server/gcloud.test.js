import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveGcloud,
  runGcloud,
  activeAccount,
  listProjects,
  enabledServices,
  enableService,
} from './gcloud.js';

const GCLOUD = 'C:\\fake\\gcloud.cmd';

// A fake exec that records every call and answers with the given result.
function fakeExec(result = { code: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const exec = async (path, args) => {
    calls.push({ path, args });
    return typeof result === 'function' ? result(path, args) : result;
  };
  return { exec, calls };
}

test('runGcloud rejects unsafe arguments before exec is called', async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(runGcloud(['x & del'], { exec, gcloudPath: GCLOUD }));
  await assert.rejects(runGcloud(['gmail api'], { exec, gcloudPath: GCLOUD }));
  assert.equal(calls.length, 0);
});

test('runGcloud appends --format=json and --quiet to every call', async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: '[]', stderr: '' });
  await runGcloud(['projects', 'list'], { exec, gcloudPath: GCLOUD });
  assert.equal(calls[0].path, GCLOUD);
  assert.deepEqual(calls[0].args, ['projects', 'list', '--format=json', '--quiet']);
});

test('listProjects maps the project list to projectId and name', async () => {
  const stdout = JSON.stringify([{ projectId: 'hm-honey-site', name: 'HM Honey Site', projectNumber: '123' }]);
  const { exec } = fakeExec({ code: 0, stdout, stderr: '' });
  const projects = await listProjects({ exec, gcloudPath: GCLOUD });
  assert.deepEqual(projects, [{ projectId: 'hm-honey-site', name: 'HM Honey Site' }]);
});

test('a missing gcloud gives a plain message with the install link and no stack trace', async () => {
  const { exec } = fakeExec({ code: 1, stdout: '', stderr: "'gcloud' is not recognized as an internal or external command" });
  await assert.rejects(listProjects({ exec, gcloudPath: GCLOUD }), (err) => {
    assert.match(err.message, /cloud\.google\.com\/sdk\/docs\/install/);
    assert.doesNotMatch(err.message, /\n\s+at /);
    return true;
  });
});

test('a project-not-found message is reported as itself, not as a missing gcloud', async () => {
  const { exec } = fakeExec({ code: 1, stdout: '', stderr: 'ERROR: project not found or permission denied' });
  await assert.rejects(listProjects({ exec }), (err) => err.code === 'GCLOUD_FAILED' && /project not found/.test(err.message));
});

test('no active account gives a message telling the user to run gcloud auth login', async () => {
  const stderr = 'ERROR: (gcloud.projects.list) You do not currently have an active account selected.';
  const { exec } = fakeExec({ code: 1, stdout: '', stderr });
  await assert.rejects(listProjects({ exec, gcloudPath: GCLOUD }), (err) => {
    assert.match(err.message, /gcloud auth login/);
    return true;
  });
});

test('activeAccount returns the account and null when nothing is signed in', async () => {
  const signedIn = fakeExec({ code: 0, stdout: '"alex@example.com"\n', stderr: '' });
  assert.equal(await activeAccount({ exec: signedIn.exec, gcloudPath: GCLOUD }), 'alex@example.com');
  assert.deepEqual(signedIn.calls[0].args, ['config', 'get-value', 'account', '--format=json', '--quiet']);

  const empty = fakeExec({ code: 0, stdout: '', stderr: '' });
  assert.equal(await activeAccount({ exec: empty.exec, gcloudPath: GCLOUD }), null);

  const noAccount = fakeExec({
    code: 1,
    stdout: '',
    stderr: 'ERROR: (gcloud.config.get-value) You do not currently have an active account selected.',
  });
  assert.equal(await activeAccount({ exec: noAccount.exec, gcloudPath: GCLOUD }), null);
});

test('permission denied gives a plain message', async () => {
  const { exec } = fakeExec({ code: 1, stdout: '', stderr: 'ERROR: (gcloud.services.list) PERMISSION_DENIED: nope' });
  await assert.rejects(enabledServices('hm-honey-site', { exec, gcloudPath: GCLOUD }), (err) => {
    assert.match(err.message, /permission denied/i);
    return true;
  });
});

test('enabledServices returns plain service names from either JSON shape', async () => {
  const stdout = JSON.stringify([
    { config: { name: 'gmail.googleapis.com' } },
    { name: 'projects/123/services/calendar-json.googleapis.com' },
  ]);
  const { exec, calls } = fakeExec({ code: 0, stdout, stderr: '' });
  const names = await enabledServices('hm-honey-site', { exec, gcloudPath: GCLOUD });
  assert.deepEqual(names, ['gmail.googleapis.com', 'calendar-json.googleapis.com']);
  assert.deepEqual(calls[0].args, ['services', 'list', '--enabled', '--project=hm-honey-site', '--format=json', '--quiet']);
});

test('enabledServices rejects a bad project id before exec is called', async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(enabledServices('Bad Id!', { exec, gcloudPath: GCLOUD }));
  assert.equal(calls.length, 0);
});

test('enableService runs services enable for a valid project and API', async () => {
  const { exec, calls } = fakeExec({ code: 0, stdout: '', stderr: '' });
  await enableService('hm-honey-site', 'gmail.googleapis.com', { exec, gcloudPath: GCLOUD });
  assert.deepEqual(calls[0].args, ['services', 'enable', 'gmail.googleapis.com', '--project=hm-honey-site', '--format=json', '--quiet']);
});

test('enableService rejects a bad API name before exec is called', async () => {
  const { exec, calls } = fakeExec();
  await assert.rejects(enableService('hm-honey-site', 'gmail', { exec, gcloudPath: GCLOUD }));
  await assert.rejects(enableService('hm-honey-site', 'gmail.example.com', { exec, gcloudPath: GCLOUD }));
  assert.equal(calls.length, 0);
});

test('resolveGcloud picks the LOCALAPPDATA path on win32 when PATH has none', () => {
  const localAppData = 'C:\\Users\\alex\\AppData\\Local';
  const expected = 'C:\\Users\\alex\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd';
  const found = resolveGcloud({
    env: { PATH: 'C:\\Windows;C:\\Tools', LOCALAPPDATA: localAppData },
    platform: 'win32',
    exists: (p) => p === expected,
    settingsPath: null,
  });
  assert.equal(found, expected);
});

test('resolveGcloud on win32 skips the extensionless bash script and takes gcloud.cmd', () => {
  const dir = 'C:\\Google\\Cloud SDK\\google-cloud-sdk\\bin';
  const cmd = `${dir}\\gcloud.cmd`;
  const found = resolveGcloud({
    env: { PATH: dir },
    platform: 'win32',
    exists: (p) => p === `${dir}\\gcloud` || p === cmd,
    settingsPath: null,
  });
  assert.equal(found, cmd);
});

test('resolveGcloud prefers an explicit settings path that exists', () => {
  const settingsPath = 'D:\\SDK\\gcloud.cmd';
  const found = resolveGcloud({
    env: { PATH: 'C:\\Tools', LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' },
    platform: 'win32',
    exists: (p) => p === settingsPath || p === 'C:\\Tools\\gcloud.cmd',
    settingsPath,
  });
  assert.equal(found, settingsPath);
});

test('resolveGcloud finds gcloud on PATH and returns null when nothing exists', () => {
  const found = resolveGcloud({
    env: { PATH: '/usr/local/bin:/opt/google/bin' },
    platform: 'darwin',
    exists: (p) => p === '/opt/google/bin/gcloud',
    settingsPath: null,
  });
  assert.equal(found, '/opt/google/bin/gcloud');

  const none = resolveGcloud({ env: { PATH: '/usr/bin' }, platform: 'darwin', exists: () => false, settingsPath: null });
  assert.equal(none, null);
});
