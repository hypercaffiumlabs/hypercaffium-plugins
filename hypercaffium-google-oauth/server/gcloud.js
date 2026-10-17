// Runs the Google Cloud CLI (gcloud) for the plugin. Nothing here opens a browser.
// Every function takes an injected deps object so the tests can use a fake exec.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';

// Google Cloud project ids: 6 to 30 characters, lowercase letters, digits and hyphens.
export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// API names such as gmail.googleapis.com.
export const API_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.googleapis\.com$/;
// Only these characters may reach gcloud, so nothing can be smuggled into a shell command.
const SAFE_ARG = /^[A-Za-z0-9@._:=\/-]+$/;
const INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';

// Finds gcloud. Order: explicit settings path, then PATH, then the default Windows install folder.
export function resolveGcloud({ env, platform, exists, settingsPath }) {
  if (settingsPath && exists(settingsPath)) return settingsPath;
  const p = platform === 'win32' ? path.win32 : path.posix;
  // On Windows the extensionless "gcloud" is a bash script that cannot be spawned, so only .cmd/.exe count.
  const names = platform === 'win32' ? ['gcloud.cmd', 'gcloud.exe'] : ['gcloud'];
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const candidate = p.join(env.LOCALAPPDATA, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd');
    if (exists(candidate)) return candidate;
  }
  return null;
}

// The real exec. Uses a shell only for .cmd files (Windows), and quotes the path for that case.
export function defaultExec(file, args) {
  const useShell = file.toLowerCase().endsWith('.cmd');
  const command = useShell ? `"${file}"` : file;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { shell: useShell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 1, stdout, stderr: err.message });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      resolve({ code: 1, stdout, stderr: err.code === 'ENOENT' ? 'gcloud is not installed or cannot be found' : err.message });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function plainError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Turns gcloud's stderr into a short plain-English message. Never includes a stack trace.
function explainFailure(stderr) {
  if (/not installed|not recognized|cannot be found|ENOENT/i.test(stderr)) {
    return plainError('GCLOUD_NOT_INSTALLED',
      `The Google Cloud CLI (gcloud) is not installed or could not be found. Install it from ${INSTALL_URL}, then try again.`);
  }
  if (/You do not currently have an active account/i.test(stderr)) {
    return plainError('NO_ACCOUNT',
      'No Google account is signed in to gcloud. Run "gcloud auth login" in a terminal, then try again.');
  }
  if (/PERMISSION_DENIED/i.test(stderr)) {
    return plainError('PERMISSION_DENIED',
      'Google Cloud refused this request (permission denied). The signed-in account may not have access to this project.');
  }
  const firstLine = stderr.split('\n').map((l) => l.trim()).find(Boolean) || 'no details were given';
  const short = firstLine.length > 300 ? `${firstLine.slice(0, 300)}...` : firstLine;
  return plainError('GCLOUD_FAILED', `gcloud could not finish the request: ${short}`);
}

// Runs one gcloud command and returns its parsed JSON output (or null when there is none).
export async function runGcloud(args, deps = {}) {
  for (const arg of args) {
    if (typeof arg !== 'string' || !SAFE_ARG.test(arg)) {
      throw plainError('BAD_ARGUMENT', `The value "${String(arg)}" contains characters that are not allowed in a Google Cloud command.`);
    }
  }
  const exec = deps.exec ?? defaultExec;
  const gcloudPath = deps.gcloudPath ?? resolveGcloud({
    env: process.env,
    platform: process.platform,
    exists: fs.existsSync,
    settingsPath: loadConfig().gcloudPath,
  });
  if (!gcloudPath) throw explainFailure('not installed');

  const result = await exec(gcloudPath, [...args, '--format=json', '--quiet']);
  if (result.code !== 0) throw explainFailure(result.stderr || '');

  const out = (result.stdout || '').trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    throw plainError('BAD_OUTPUT', 'gcloud returned output that could not be read.');
  }
}

function checkProjectId(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) {
    throw plainError('BAD_PROJECT_ID', `"${String(projectId)}" is not a valid Google Cloud project id.`);
  }
}

function checkApiName(api) {
  if (typeof api !== 'string' || !API_NAME.test(api)) {
    throw plainError('BAD_API_NAME', `"${String(api)}" is not a valid Google API name, such as gmail.googleapis.com.`);
  }
}

// The account gcloud is signed in with, or null when nobody is signed in.
export async function activeAccount(deps = {}) {
  let value;
  try {
    value = await runGcloud(['config', 'get-value', 'account'], deps);
  } catch (err) {
    if (err.code === 'NO_ACCOUNT') return null;
    throw err;
  }
  const account = typeof value === 'string' ? value.trim() : '';
  return account && account !== '(unset)' ? account : null;
}

export async function listProjects(deps = {}) {
  const value = await runGcloud(['projects', 'list'], deps);
  if (!Array.isArray(value)) return [];
  return value.map((p) => ({ projectId: p.projectId, name: p.name }));
}

// Plain service names such as gmail.googleapis.com, for one project.
export async function enabledServices(projectId, deps = {}) {
  checkProjectId(projectId);
  const value = await runGcloud(['services', 'list', '--enabled', `--project=${projectId}`], deps);
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const raw = item?.config?.name || item?.name || '';
      return raw.includes('/services/') ? raw.split('/services/').pop() : raw;
    })
    .filter(Boolean);
}

export async function enableService(projectId, api, deps = {}) {
  checkProjectId(projectId);
  checkApiName(api);
  await runGcloud(['services', 'enable', api, `--project=${projectId}`], deps);
}
