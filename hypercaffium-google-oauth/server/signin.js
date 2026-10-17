// Moves Google's downloaded OAuth client file into place, registers an account with the tool,
// and runs the tool's own login command. Secrets (client secret, tokens) are never returned,
// logged or put into error messages.
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { expand } from './recipes.js';

const EMAIL_BRIEF = /^[^\s@{}"'&|;<>]+@[^\s@{}"'&|;<>]+\.[A-Za-z]{2,}$/;
const EMAIL_STRICT = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const ACCOUNT_TYPE = /^[A-Za-z0-9 _-]*$/;
// Control characters and the shell/template characters that are never allowed in a note.
const NOTE_BAD = /[\u0000-\u001f\u007f"'{}`$%&|;<>]/;
const SAFE_ARG = /^[A-Za-z0-9@._:=\/\\+-]+$/;

function realDeps(deps = {}) {
  return {
    fs: deps.fs || nodeFs,
    spawn: deps.spawn || nodeSpawn,
    home: deps.home || os.homedir(),
    downloadsDir: deps.downloadsDir,
    platform: deps.platform || process.platform,
  };
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function validateAccountInput({ email, accountType, note }) {
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_BRIEF.test(email) || !EMAIL_STRICT.test(email)) {
    throw new Error('The email address is not valid.');
  }
  if (accountType !== undefined && accountType !== null && accountType !== '') {
    if (typeof accountType !== 'string' || accountType.length > 30 || !ACCOUNT_TYPE.test(accountType)) {
      throw new Error('The account type may use up to 30 letters, digits, spaces, underscores or hyphens.');
    }
  }
  if (note !== undefined && note !== null && note !== '') {
    if (typeof note !== 'string' || note.length > 120 || NOTE_BAD.test(note)) {
      throw new Error('The note is too long or uses characters that are not allowed.');
    }
  }
}

// Writes a file next to its destination and renames it into place.
function atomicWrite(fs, file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
}

export function installClientFile({ downloadedFile, recipe, allowOverwrite } = {}, deps) {
  const d = realDeps(deps);
  const { fs } = d;
  if (typeof downloadedFile !== 'string' || downloadedFile === '') throw new Error('No downloaded file was given.');
  if (downloadedFile.startsWith('\\\\') || downloadedFile.startsWith('//')) {
    throw new Error('Network paths are not accepted. Use a file in your Downloads folder.');
  }
  const downloads = d.downloadsDir || path.join(d.home, 'Downloads');
  let realFile;
  let realDownloads;
  try {
    realFile = fs.realpathSync(downloadedFile);
    realDownloads = fs.realpathSync(downloads);
  } catch {
    throw new Error('The downloaded file or the Downloads folder could not be found.');
  }
  if (!isInside(realDownloads, realFile)) throw new Error('The downloaded file must be inside your Downloads folder.');

  const key = recipe.clientType === 'web' ? 'web' : 'installed';
  let text;
  let parsed;
  try {
    text = fs.readFileSync(realFile, 'utf8');
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The downloaded file is not valid JSON.');
  }
  const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [];
  const body = keys.length === 1 && keys[0] === key ? parsed[key] : null;
  if (!body || typeof body.client_id !== 'string' || typeof body.client_secret !== 'string') {
    throw new Error(`The downloaded file is not a ${recipe.clientType} OAuth client file (expected a "${key}" section with a client id and secret).`);
  }

  const target = expand(recipe.clientFile, { home: d.home });
  if (fs.existsSync(target) && !allowOverwrite) {
    throw new Error(`A client file already exists at ${target}. It was not replaced.`);
  }
  atomicWrite(fs, target, text, 0o600);
  fs.unlinkSync(realFile);
  return { installedTo: target, clientId: body.client_id };
}

export function addAccount({ recipe, email, accountType, note } = {}, deps) {
  const d = realDeps(deps);
  validateAccountInput({ email, accountType, note });
  if (!recipe.accountsFile) return { added: false, reason: 'no accounts file' };
  const { path: p, listKey, entry } = recipe.accountsFile;
  const file = expand(p, { home: d.home });
  let doc = { [listKey]: [] };
  if (d.fs.existsSync(file)) {
    try {
      doc = JSON.parse(d.fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('The accounts file is not valid JSON, so it was left alone.');
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('The accounts file has an unexpected shape.');
  }
  if (doc[listKey] === undefined) doc[listKey] = [];
  if (!Array.isArray(doc[listKey])) throw new Error('The accounts file has an unexpected shape.');
  if (doc[listKey].some((e) => e && e.email === email)) return { added: false, reason: 'already present' };
  const vars = { home: d.home, email, accountType: accountType || '', note: note || '' };
  const row = {};
  for (const [k, v] of Object.entries(entry)) row[k] = expand(v, vars);
  doc[listKey].push(row);
  atomicWrite(d.fs, file, `${JSON.stringify(doc, null, 2)}\n`);
  return { added: true };
}

// Runs argv without a shell and resolves { code, timedOut }.
function run(d, argv, cwd, timeoutSec) {
  let cmd = argv[0];
  let args = argv.slice(1);
  if (d.platform === 'win32') {
    args = ['/d', '/s', '/c', ...argv];
    cmd = 'cmd.exe';
  }
  return new Promise((resolve) => {
    let done = false;
    let timedOut = false;
    const child = d.spawn(cmd, args, { cwd, shell: false, windowsHide: true, stdio: 'ignore' });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, timedOut });
    };
    const stop = () => {
      if (d.platform === 'win32') {
        // cmd.exe is only a wrapper, so end the whole process tree.
        try {
          const k = d.spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { shell: false, windowsHide: true, stdio: 'ignore' });
          if (k && typeof k.on === 'function') k.on('error', () => {});
        } catch { /* nothing more to do */ }
        return;
      }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000);
      if (typeof hard.unref === 'function') hard.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      finish(null);
    }, timeoutSec * 1000);
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
}

export async function signInAccount({ recipe, email, accountType, note } = {}, deps) {
  const d = realDeps(deps);
  validateAccountInput({ email, accountType, note });
  const vars = { home: d.home, email };
  const command = expand(recipe.login.command, vars);
  if (/["'`]/.test(command)) throw new Error('The login command may not contain quotes.');
  const argv = command.split(/\s+/).filter((x) => x !== '');
  if (argv.length === 0) throw new Error('The login command is empty.');
  if (d.platform === 'win32' && !argv.every((a) => SAFE_ARG.test(a))) {
    throw new Error('The login command has characters that are not allowed.');
  }
  const cwd = recipe.login.cwd ? expand(recipe.login.cwd, vars) : d.home;
  const tokenFile = expand(recipe.tokens.path, vars);
  if (!isInside(cwd, tokenFile) && !isInside(d.home, tokenFile)) {
    throw new Error('The token file location is outside the allowed folders.');
  }

  addAccount({ recipe, email, accountType, note }, d);

  const before = d.fs.existsSync(tokenFile) ? d.fs.statSync(tokenFile).mtimeMs : null;
  const timeoutSec = recipe.login.timeoutSec || 300;
  const { code, timedOut } = await run(d, argv, cwd, timeoutSec);
  if (timedOut) return { ok: false, tokenFile, message: `Sign-in did not finish within ${timeoutSec} seconds and was stopped.` };
  if (code !== 0) return { ok: false, tokenFile, message: 'The login command did not finish successfully.' };

  let has = false;
  try {
    if (d.fs.existsSync(tokenFile) && (before === null || d.fs.statSync(tokenFile).mtimeMs > before)) {
      const t = JSON.parse(d.fs.readFileSync(tokenFile, 'utf8'));
      const v = t && t[recipe.tokens.refreshTokenField];
      has = typeof v === 'string' && v !== '';
    }
  } catch { has = false; }
  if (!has) return { ok: false, tokenFile, message: 'The login command ran but no new sign-in token was saved.' };
  return { ok: true, tokenFile, message: `Signed in ${email}.` };
}
