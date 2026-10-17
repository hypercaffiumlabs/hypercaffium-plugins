// Append-only change/activity log. One JSON object per line, one file per month.
// Never throws: a logging problem must never break a tool call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function auditDir() {
  return process.env.CLAUDE_PLUGINS_AUDIT_DIR || path.join(os.homedir(), '.claude-plugins', 'audit');
}

export function auditFile(plugin, date = new Date()) {
  const month = date.toISOString().slice(0, 7);
  return path.join(auditDir(), `${plugin}-${month}.jsonl`);
}

// Long strings are trimmed so the log stays readable; no secrets are ever passed in args.
const SECRET_KEY = /pass(word|phrase)?|secret|token|private|credential/i;

function sanitize(value, depth = 0) {
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  if (depth > 3 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[hidden]' : sanitize(v, depth + 1)]));
}

export function audit(plugin, entry) {
  try {
    fs.mkdirSync(auditDir(), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...sanitize(entry) });
    fs.appendFileSync(auditFile(plugin), `${line}\n`);
  } catch {
    // intentionally ignored
  }
}

export function readAudit(plugin, limit = 25) {
  const entries = [];
  try {
    const files = fs
      .readdirSync(auditDir())
      .filter((f) => f.startsWith(`${plugin}-`) && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    for (const f of files) {
      const lines = fs.readFileSync(path.join(auditDir(), f), 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try {
          entries.push(JSON.parse(lines[i]));
        } catch {
          // skip a damaged line
        }
      }
      if (entries.length >= limit) break;
    }
  } catch {
    // no log yet
  }
  return entries; // newest first
}
