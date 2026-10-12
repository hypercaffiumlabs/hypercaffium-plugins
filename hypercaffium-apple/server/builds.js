// Uploading an iOS build (.ipa) through Apple's build-upload API: reserve the upload, send the
// bytes to the URLs Apple returns, mark it uploaded with its checksum, then follow processing.
// "uploads" feature, Tier 2. The version and build number come from inside the file, and a build
// number Apple already has is refused before anything is sent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readIpaInfo } from './ipa.js';
import { list, resolveApp } from './release.js';
import { currentFeatures } from './rules.js';
import { toLocalTime } from './util.js';

const MAX_IPA = 4 * 1024 * 1024 * 1024;
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function prepareUploadBuild(deps, { appId, file, platform = 'IOS' }) {
  if (!currentFeatures().uploads) {
    return { allowed: false, tier: 3, blocked: true, reason: 'The "uploads" feature is switched off in your settings. Run /hypercaffium-apple:setup to see or change your settings.' };
  }
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Pass file: the full path to the .ipa.');
  if (!file.toLowerCase().endsWith('.ipa')) throw new Error(`${path.basename(file)} must be an .ipa file.`);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`${file} does not exist.`);
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_IPA) throw new Error(`${path.basename(file)} is not a usable .ipa (empty or over 4 GB).`);
  const buf = fs.readFileSync(file);
  const info = readIpaInfo(buf);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');

  const app = await resolveApp(deps, appId);
  const appInfo = await deps.get(`/v1/apps/${enc(app)}`);
  const bundleId = appInfo?.data?.attributes?.bundleId;
  if (bundleId && info.bundleId && bundleId !== info.bundleId) {
    throw new Error(`This .ipa is for ${info.bundleId}, but the app is ${bundleId}.`);
  }
  const same = list(await deps.get(`/v1/builds?filter[app]=${enc(app)}&filter[version]=${enc(info.buildNumber)}&filter[preReleaseVersion.version]=${enc(info.versionString)}&limit=1`));
  if (same.length) throw new Error(`Apple already has build ${info.buildNumber} of version ${info.versionString}. Bump the build number and build again.`);

  const title = `Upload ${path.basename(file)} (version ${info.versionString}, build ${info.buildNumber}) to App Store Connect`;
  const payload = { kind: 'buildUpload', tier: 2, title, app, platform, info, file: { path: file, name: path.basename(file), size: st.size, md5 } };
  const ticket = deps.store.create(payload);
  return {
    allowed: true,
    kind: 'buildUpload',
    tier: 2,
    tierReason: 'uploads a new build; it goes to TestFlight processing and is not public until you attach and submit it',
    feature: 'uploads',
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    title,
    file: { name: payload.file.name, sizeMB: Math.round((st.size / 1048576) * 10) / 10 },
    insideTheFile: info,
    afterUpload: 'Apple processes the build (usually 5 to 30 minutes). Then it can go to TestFlight testers (asc_testflight_add_build_to_group) or be attached to a version (asc_attach_build).',
    nextStep: 'Show this to the owner and wait for an explicit yes, then apply with asc_apply_change. Large files take a few minutes.',
  };
}

export async function runBuildUpload(payload, deps, { fetchImpl = fetch, pollMs = 15000, pollTries = 8 } = {}) {
  if (!currentFeatures().uploads) throw new Error('The "uploads" feature was switched off since the preview, so this upload is refused.');
  const { app, platform, info, file } = payload;
  const steps = [];
  let uploadId;
  try {
    const buf = fs.readFileSync(file.path);
    if (buf.length !== file.size || crypto.createHash('md5').update(buf).digest('hex') !== file.md5) {
      throw new Error(`${file.name} changed on disk since the preview. Prepare again.`);
    }
    const upload = await deps.send('POST', '/v1/buildUploads', {}, {
      data: {
        type: 'buildUploads',
        attributes: { cfBundleShortVersionString: info.versionString, cfBundleVersion: info.buildNumber, platform },
        relationships: { app: { data: { type: 'apps', id: app } } },
      },
    });
    uploadId = upload.data.id;
    steps.push('reserved the upload');
    const fileRec = await deps.send('POST', '/v1/buildUploadFiles', {}, {
      data: {
        type: 'buildUploadFiles',
        attributes: { fileName: file.name, fileSize: file.size, uti: 'com.apple.ipa', assetType: 'ASSET' },
        relationships: { buildUpload: { data: { type: 'buildUploads', id: uploadId } } },
      },
    });
    const fileId = fileRec.data.id;
    for (const op of fileRec.data.attributes?.uploadOperations || []) {
      const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
      const res = await fetchImpl(op.url, { method: op.method || 'PUT', headers, body: buf.subarray(op.offset, op.offset + op.length) });
      if (!res.ok) throw new Error(`Uploading part of ${file.name} failed: HTTP ${res.status}`);
    }
    steps.push('sent the file');
    await deps.send('PATCH', `/v1/buildUploadFiles/${enc(fileId)}`, {}, {
      data: { type: 'buildUploadFiles', id: fileId, attributes: { uploaded: true, sourceFileChecksums: { file: { hash: file.md5, algorithm: 'MD5' } } } },
    });
    steps.push('confirmed the upload with its checksum');
    let state = 'UPLOADED';
    let errors;
    for (let i = 0; i < pollTries; i++) {
      const cur = await deps.get(`/v1/buildUploads/${enc(uploadId)}`);
      state = cur.data?.attributes?.state?.state || cur.data?.attributes?.state || state;
      errors = cur.data?.attributes?.state?.errors;
      if (['COMPLETE', 'FAILED'].includes(state)) break;
      await sleep(pollMs);
    }
    return {
      applied: state !== 'FAILED',
      tier: payload.tier,
      title: payload.title,
      steps,
      uploadState: state,
      errors,
      next: state === 'FAILED' ? 'Apple rejected the build; see errors.' : 'Apple keeps processing in the background. Check with asc_list_builds in a few minutes.',
    };
  } catch (err) {
    return {
      applied: false,
      tier: payload.tier,
      title: payload.title,
      steps,
      uploadId,
      error: String(err.message || err),
      advice: uploadId
        ? 'An unfinished upload record may remain; Apple discards it. Fix the problem and upload again (the same build number is fine because it never finished).'
        : 'Nothing was sent to Apple.',
    };
  }
}
