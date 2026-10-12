// Uploading an Android App Bundle (.aab), optionally with its crash-decoding (R8/ProGuard mapping)
// file, and putting it on a track: all inside ONE Play edit, committed together or discarded.
// "uploads" feature (plus "releases", since it places a release on a track). Tier 2.
//
// Safety choices: production uploads are always DRAFT releases (go live later with play_set_release
// or play_rollout, after looking at it); the file is re-checked byte for byte before upload; and if
// anything fails, the edit is discarded, so nothing at all reaches Google Play.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentFeatures } from './rules.js';
import { checkNotes, readTrack, readVersionCodes } from './release.js';
import { toLocalTime } from './util.js';

const APP = '/androidpublisher/v3/applications';
const MAX_BUNDLE = 2 * 1024 * 1024 * 1024;
const MAX_MAPPING = 300 * 1024 * 1024;

function inspect(p, { ext, max, zip }) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`"${p}" must be a full file path.`);
  if (!p.toLowerCase().endsWith(ext)) throw new Error(`${path.basename(p)} must be a ${ext} file.`);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(`${p} does not exist.`);
  }
  if (!st.isFile() || st.size === 0) throw new Error(`${p} is not a usable file.`);
  if (st.size > max) throw new Error(`${path.basename(p)} is larger than Google Play accepts.`);
  const buf = fs.readFileSync(p);
  if (zip && buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${path.basename(p)} is not a valid app bundle (it is not a zip archive).`);
  return { path: p, name: path.basename(p), size: st.size, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

const off = (keys) => {
  const f = currentFeatures();
  const missing = keys.filter((k) => !f[k]);
  return missing.length
    ? { allowed: false, tier: 3, blocked: true, reason: `The "${missing.join('", "')}" feature is switched off in your settings. Run /hypercaffium-play:setup to see or change your settings.` }
    : null;
};

export async function prepareUploadBundle(deps, { packageName, file, mappingFile, track = 'internal', status, userFraction, releaseNotes }) {
  const blocked = off(['uploads', 'releases']);
  if (blocked) return blocked;
  const pkg = packageName || deps.defaultPackage();
  const isProd = track === 'production';
  const finalStatus = isProd ? 'draft' : status || 'completed';
  if (isProd && status && status !== 'draft') {
    throw new Error('Uploads to production are always a DRAFT release. Look at it, then make it live with play_set_release or play_rollout.');
  }
  if (!['draft', 'completed', 'inProgress'].includes(finalStatus)) throw new Error('status must be draft, completed or inProgress.');
  if (finalStatus === 'inProgress' && !(userFraction > 0 && userFraction < 1)) throw new Error('A staged rollout needs userFraction between 0 and 1 (0.1 = 10%).');
  const notes = releaseNotes === undefined ? undefined : checkNotes(releaseNotes);
  const bundle = inspect(file, { ext: '.aab', max: MAX_BUNDLE, zip: true });
  const mapping = mappingFile ? inspect(mappingFile, { ext: '.txt', max: MAX_MAPPING }) : null;

  const current = await readTrack(deps, pkg, track);
  const codes = await readVersionCodes(deps, pkg);
  const highest = codes.length ? Math.max(...codes) : 0;

  const title = `Upload ${bundle.name} to the ${track} track as a ${finalStatus} release`;
  const payload = { kind: 'bundle', tier: 2, title, pkg, track, status: finalStatus, userFraction, notes, bundle, mapping };
  const ticket = deps.store.create(payload);
  return {
    allowed: true,
    kind: 'bundle',
    tier: 2,
    tierReason: isProd ? 'uploads a new version as a production DRAFT (nobody gets it until you release it)' : `uploads a new version that ${track} testers can install`,
    feature: 'uploads, releases',
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    title,
    file: { name: bundle.name, sizeMB: Math.round((bundle.size / 1048576) * 10) / 10, sha256: bundle.sha256 },
    mappingFile: mapping ? { name: mapping.name, sizeMB: Math.round((mapping.size / 1048576) * 10) / 10 } : 'none (crash reports for this version will not be decoded)',
    versionCodeRule: `Its version code must be higher than every one already uploaded (highest now: ${highest || 'none'}). Google reads it from the file and refuses the upload otherwise.`,
    currentlyOnTrack: current.releases.map((r) => ({ status: r.status, versionCodes: r.versionCodes, name: r.name })),
    committedTogether: 'Upload, mapping file and track change happen inside ONE Play edit and are committed together, or not at all.',
    nextStep: 'Show this to the owner and wait for an explicit yes, then apply with play_apply_change. Large files can take a few minutes.',
  };
}

export async function runBundle(payload, deps) {
  const missing = ['uploads', 'releases'].filter((k) => !currentFeatures()[k]);
  if (missing.length) throw new Error(`The "${missing.join('", "')}" feature was switched off since the preview, so this upload is refused.`);
  const { pkg, track, status, userFraction, notes, bundle, mapping } = payload;
  const steps = [];
  let edit;
  try {
    const bytes = fs.readFileSync(bundle.path);
    if (bytes.length !== bundle.size || crypto.createHash('sha256').update(bytes).digest('hex') !== bundle.sha256) {
      throw new Error(`${bundle.name} changed on disk since the preview. Prepare again.`);
    }
    const mapBytes = mapping ? fs.readFileSync(mapping.path) : null;
    if (mapping && (mapBytes.length !== mapping.size || crypto.createHash('sha256').update(mapBytes).digest('hex') !== mapping.sha256)) {
      throw new Error(`${mapping.name} changed on disk since the preview. Prepare again.`);
    }

    edit = await deps.send('POST', `${APP}/${pkg}/edits`, {}, {});
    const uploaded = await deps.uploadBundle({ pkg, editId: edit.id, bytes });
    const versionCode = Number(uploaded.versionCode);
    if (!Number.isInteger(versionCode)) throw new Error('Google did not report a version code for the uploaded bundle.');
    if (uploaded.sha256 && uploaded.sha256 !== bundle.sha256) throw new Error('Google received different bytes than the file that was previewed. Nothing was committed.');
    steps.push(`uploaded ${bundle.name} (version code ${versionCode})`);
    if (mapping) {
      await deps.uploadMapping({ pkg, editId: edit.id, versionCode, bytes: mapBytes });
      steps.push(`attached ${mapping.name}`);
    }

    // Put it on the track: same rule as play_set_release (keep the completed release that keeps
    // serving everyone else while a new one is draft or staged).
    const cur = await deps.get(`${APP}/${pkg}/edits/${edit.id}/tracks/${track}`, {});
    const release = { status, versionCodes: [String(versionCode)] };
    if (status === 'inProgress') release.userFraction = userFraction;
    if (notes) release.releaseNotes = notes;
    const keep = (cur.releases || []).filter((r) => r.status === 'completed' && status !== 'completed');
    await deps.send('PUT', `${APP}/${pkg}/edits/${edit.id}/tracks/${track}`, {}, { track, releases: [release, ...keep] });
    steps.push(`set a ${status} release on ${track}`);

    const commit = await deps.send('POST', `${APP}/${pkg}/edits/${edit.id}:commit`, {}, undefined);
    return { applied: true, committed: true, tier: payload.tier, title: payload.title, versionCode, steps, commit };
  } catch (err) {
    if (edit?.id) await deps.send('DELETE', `${APP}/${pkg}/edits/${edit.id}`, {}, undefined).catch(() => {});
    return {
      applied: false,
      committed: false,
      tier: payload.tier,
      title: payload.title,
      doneBeforeFailure: steps,
      error: String(err.message || err),
      advice: 'Nothing was committed: the edit was discarded, so Google Play is unchanged.',
    };
  }
}
