// Screenshot and app preview (video) upload, to a DRAFT App Store version or to a custom product
// page's draft. Apple's flow: reserve a slot, PUT the bytes to the URLs Apple returns, commit with an
// MD5 checksum, then wait for processing. Only ADDS: removing uses asc_clear_screenshots (drafts only).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentFeatures, EDITABLE_VERSION_STATES } from './rules.js';
import { findOperation } from './plans.js';
import { findVersion, list, resolveApp } from './release.js';
import { preparePlan } from './plans.js';
import { validateBody } from './spec.js';
import { toLocalTime } from './util.js';

export const MAX_PER_SET = 10;
export const MAX_PREVIEWS_PER_SET = 3;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

// What differs between the two kinds of asset.
const ASSET = {
  screenshot: { setPath: '/v1/appScreenshotSets', setType: 'appScreenshotSets', typeAttr: 'screenshotDisplayType', itemPath: '/v1/appScreenshots', itemType: 'appScreenshots', setRel: 'appScreenshotSet', many: 'appScreenshots' },
  preview: { setPath: '/v1/appPreviewSets', setType: 'appPreviewSets', typeAttr: 'previewType', itemPath: '/v1/appPreviews', itemType: 'appPreviews', setRel: 'appPreviewSet', many: 'appPreviews' },
};
const enc = encodeURIComponent;

// ---- image header sniffing (no dependencies) -------------------------------

export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function inspectFile(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`"${p}" must be a full file path (for example C:\\Users\\you\\Pictures\\shot1.png).`);
  if (!/\.(png|jpe?g)$/i.test(p)) throw new Error(`${path.basename(p)}: only PNG or JPEG screenshots are accepted.`);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(`${p} does not exist.`);
  }
  if (!st.isFile()) throw new Error(`${p} is not a file.`);
  if (st.size === 0 || st.size > MAX_FILE_BYTES) throw new Error(`${path.basename(p)}: size must be between 1 byte and ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const buf = fs.readFileSync(p);
  const dims = imageSize(buf);
  if (!dims) throw new Error(`${path.basename(p)} does not look like a valid PNG or JPEG.`);
  return { path: p, name: path.basename(p), size: st.size, md5: crypto.createHash('md5').update(buf).digest('hex'), width: dims.width, height: dims.height, format: dims.type };
}

const VIDEO_MIME = { mov: 'video/quicktime', m4v: 'video/x-m4v', mp4: 'video/mp4' };

export function inspectVideo(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`"${p}" must be a full file path.`);
  const ext = (/\.(mov|m4v|mp4)$/i.exec(p) || [])[1]?.toLowerCase();
  if (!ext) throw new Error(`${path.basename(p)}: app previews must be .mov, .m4v or .mp4 videos.`);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(`${p} does not exist.`);
  }
  if (!st.isFile() || st.size === 0) throw new Error(`${p} is not a usable file.`);
  if (st.size > MAX_VIDEO_BYTES) throw new Error(`${path.basename(p)} is over Apple's 500 MB limit for app previews.`);
  const buf = fs.readFileSync(p);
  // MP4 and QuickTime files start with a size and a box name such as ftyp, moov, wide or mdat.
  if (!['ftyp', 'moov', 'wide', 'mdat', 'free'].includes(buf.subarray(4, 8).toString('latin1'))) {
    throw new Error(`${path.basename(p)} does not look like an MP4 or QuickTime video.`);
  }
  return { path: p, name: path.basename(p), size: st.size, md5: crypto.createHash('md5').update(buf).digest('hex'), mime: VIDEO_MIME[ext] };
}

// Where the assets go: a draft version's localization, or a custom product page draft's localization.
async function resolveParent(deps, { appId, version, platform, locale, customProductPage }) {
  const app = await resolveApp(deps, appId);
  if (customProductPage) {
    const pages = list(await deps.get(`/v1/apps/${enc(app)}/appCustomProductPages?limit=50`));
    const page = pages.find((x) => x.id === customProductPage || x.name === customProductPage);
    if (!page) throw new Error(`No custom product page "${customProductPage}". Pages: ${pages.map((x) => x.name).join(', ') || 'none'}.`);
    const versions = list(await deps.get(`/v1/appCustomProductPages/${enc(page.id)}/appCustomProductPageVersions?limit=20`));
    const draft = versions.find((v) => ['PREPARE_FOR_SUBMISSION', 'REJECTED'].includes(v.state));
    if (!draft) throw new Error(`Custom product page "${page.name}" has no editable draft (states: ${versions.map((v) => v.state).join(', ') || 'none'}).`);
    const locs = list(await deps.get(`/v1/appCustomProductPageVersions/${enc(draft.id)}/appCustomProductPageLocalizations?limit=50`));
    const loc = locs.find((l) => l.locale === locale);
    if (!loc) throw new Error(`Custom product page "${page.name}" has no ${locale} localization.`);
    return {
      rel: { key: 'appCustomProductPageLocalization', type: 'appCustomProductPageLocalizations', id: loc.id },
      setsPath: `/v1/appCustomProductPageLocalizations/${enc(loc.id)}`,
      label: `custom product page "${page.name}" (${locale})`,
      features: ['listing', 'marketing'],
      tier: 2,
      tierReason: 'adds media to a custom product page draft; it becomes public only after Apple approves the page',
    };
  }
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'editable' });
  const state = v.appStoreState || v.appVersionState;
  if (!EDITABLE_VERSION_STATES.has(state)) throw new Error(`Version ${v.versionString} is ${state}; media can only be added while it is a draft.`);
  const locs = list(await deps.get(`/v1/appStoreVersions/${enc(v.id)}/appStoreVersionLocalizations?limit=50`));
  const loc = locs.find((l) => l.locale === locale);
  if (!loc) throw new Error(`Version ${v.versionString} has no ${locale} localization yet. Create it with asc_edit_listing first.`);
  return {
    rel: { key: 'appStoreVersionLocalization', type: 'appStoreVersionLocalizations', id: loc.id },
    setsPath: `/v1/appStoreVersionLocalizations/${enc(loc.id)}`,
    label: `${v.versionString} (${locale})`,
    version: v.versionString,
    versionState: state,
    features: ['listing'],
    tier: 1,
    tierReason: 'adding media to a draft version (not visible to users, nothing is deleted)',
  };
}

const featureOff = (features) => {
  const f = currentFeatures();
  const off = features.filter((k) => !f[k]);
  return off.length
    ? { allowed: false, tier: 3, blocked: true, reason: `The "${off.join('", "')}" feature is switched off in your settings. Run /hypercaffium-apple:setup to see or change your settings.` }
    : null;
};

// ---- prepare ---------------------------------------------------------------

export async function prepareScreenshots(deps, { appId, version, locale = 'en-US', displayType, files, platform = 'IOS', customProductPage }) {
  const off = featureOff(customProductPage ? ['listing', 'marketing'] : ['listing']);
  if (off) return off;
  if (!Array.isArray(files) || files.length === 0) throw new Error('Pass files: a list of full paths to PNG or JPEG screenshots.');
  if (files.length > MAX_PER_SET) throw new Error(`At most ${MAX_PER_SET} screenshots per set.`);
  const setOp = findOperation('POST', '/v1/appScreenshotSets');
  const typeProblems = validateBody(setOp, {
    data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: displayType }, relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: 'x' } } } },
  });
  if (typeProblems.length) throw new Error(`displayType "${displayType}" is not valid. ${typeProblems[0]}`);
  const inspected = files.map(inspectFile);
  const parent = await resolveParent(deps, { appId, version, platform, locale, customProductPage });
  return finishPrepare(deps, {
    asset: 'screenshot',
    parent,
    typeValue: displayType,
    files: inspected,
    max: MAX_PER_SET,
    locale,
    describe: (f) => ({ name: f.name, size: f.size, dimensions: `${f.width}x${f.height}`, format: f.format }),
  });
}

export async function prepareAppPreviews(deps, { appId, version, locale = 'en-US', previewType, files, previewFrameTimeCode, platform = 'IOS', customProductPage }) {
  const off = featureOff(customProductPage ? ['listing', 'marketing'] : ['listing']);
  if (off) return off;
  if (!Array.isArray(files) || files.length === 0) throw new Error('Pass files: a list of full paths to .mov, .m4v or .mp4 videos.');
  if (files.length > MAX_PREVIEWS_PER_SET) throw new Error(`At most ${MAX_PREVIEWS_PER_SET} app previews per set.`);
  if (previewFrameTimeCode && !/^\d{2}:\d{2}:\d{2}$/.test(previewFrameTimeCode)) throw new Error('previewFrameTimeCode must look like 00:00:05 (the poster frame).');
  const setOp = findOperation('POST', '/v1/appPreviewSets');
  const typeProblems = validateBody(setOp, {
    data: { type: 'appPreviewSets', attributes: { previewType }, relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: 'x' } } } },
  });
  if (typeProblems.length) throw new Error(`previewType "${previewType}" is not valid. ${typeProblems[0]}`);
  const inspected = files.map(inspectVideo);
  const parent = await resolveParent(deps, { appId, version, platform, locale, customProductPage });
  return finishPrepare(deps, {
    asset: 'preview',
    parent,
    typeValue: previewType,
    files: inspected,
    max: MAX_PREVIEWS_PER_SET,
    locale,
    previewFrameTimeCode,
    describe: (f) => ({ name: f.name, sizeMB: Math.round((f.size / 1048576) * 10) / 10 }),
  });
}

async function finishPrepare(deps, { asset, parent, typeValue, files, max, locale, previewFrameTimeCode, describe }) {
  const A = ASSET[asset];
  const sb = await deps.get(`${parent.setsPath}/${A.setType}?include=${A.many}&limit=50`);
  const set = (sb.data || []).find((x) => x.attributes?.[A.typeAttr] === typeValue) || null;
  const existing = set ? (set.relationships?.[A.many]?.data || []).length : 0;
  if (existing + files.length > max) {
    throw new Error(
      `That set already has ${existing}; adding ${files.length} would exceed ${max}.` +
        (asset === 'screenshot' && parent.version
          ? " Remove old ones first with asc_clear_screenshots (needs the owner's yes), then upload again."
          : ' Remove old ones in App Store Connect first.'),
    );
  }
  const noun = asset === 'screenshot' ? 'screenshot(s)' : 'app preview video(s)';
  const title = `Add ${files.length} ${typeValue} ${noun} to ${parent.label}`;
  const payload = { kind: 'screenshots', asset, tier: parent.tier, features: parent.features, title, parentRel: parent.rel, setId: set?.id || null, typeValue, previewFrameTimeCode, files };
  const ticket = deps.store.create(payload);
  return {
    allowed: true,
    kind: 'screenshots',
    asset,
    tier: parent.tier,
    tierReason: parent.tierReason,
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    title,
    target: parent.label,
    version: parent.version,
    versionState: parent.versionState,
    locale,
    type: typeValue,
    creatingNewSet: !set,
    existingInSet: existing,
    files: files.map(describe),
    note: 'Apple checks dimensions and length when processing. A wrong file shows up as FAILED, with nothing public affected.',
    nextStep:
      parent.tier === 1
        ? 'Low risk. Apply with asc_apply_safe_change (or asc_apply_change).'
        : 'Show this to the owner and wait for an explicit yes, then apply with asc_apply_change.',
  };
}

// ---- run -------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runScreenshots(payload, deps, { fetchImpl = fetch, pollMs = 2000, pollTries = 30 } = {}) {
  const A = ASSET[payload.asset || 'screenshot'];
  // Tickets from before previews existed carry localizationId/displayType instead.
  const parentRel = payload.parentRel || { key: 'appStoreVersionLocalization', type: 'appStoreVersionLocalizations', id: payload.localizationId };
  const typeValue = payload.typeValue || payload.displayType;
  const results = [];
  let setId = payload.setId;
  try {
    if (!setId) {
      const r = await deps.send('POST', A.setPath, {}, {
        data: {
          type: A.setType,
          attributes: { [A.typeAttr]: typeValue },
          relationships: { [parentRel.key]: { data: { type: parentRel.type, id: parentRel.id } } },
        },
      });
      setId = r.data.id;
    }
    for (const f of payload.files) {
      const entry = { file: f.name };
      results.push(entry);
      // Never upload something that changed since the preview.
      const buf = fs.readFileSync(f.path);
      if (buf.length !== f.size || crypto.createHash('md5').update(buf).digest('hex') !== f.md5) {
        throw new Error(`${f.name} changed on disk since the preview. Prepare again.`);
      }
      const attributes = { fileName: f.name, fileSize: f.size };
      if (f.mime) attributes.mimeType = f.mime;
      if (payload.previewFrameTimeCode) attributes.previewFrameTimeCode = payload.previewFrameTimeCode;
      const created = await deps.send('POST', A.itemPath, {}, {
        data: { type: A.itemType, attributes, relationships: { [A.setRel]: { data: { type: A.setType, id: setId } } } },
      });
      const shotId = created.data.id;
      entry.id = shotId;
      for (const op of created.data.attributes?.uploadOperations || []) {
        const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
        const res = await fetchImpl(op.url, { method: op.method || 'PUT', headers, body: buf.subarray(op.offset, op.offset + op.length) });
        if (!res.ok) throw new Error(`Upload of ${f.name} failed: HTTP ${res.status}`);
      }
      await deps.send('PATCH', `${A.itemPath}/${enc(shotId)}`, {}, {
        data: { type: A.itemType, id: shotId, attributes: { uploaded: true, sourceFileChecksum: f.md5 } },
      });
      let stateName = 'UPLOAD_COMPLETE';
      for (let i = 0; i < pollTries; i++) {
        const cur = await deps.get(`${A.itemPath}/${enc(shotId)}`);
        stateName = cur.data?.attributes?.assetDeliveryState?.state || stateName;
        if (stateName === 'COMPLETE' || stateName === 'FAILED') {
          entry.errors = cur.data?.attributes?.assetDeliveryState?.errors;
          break;
        }
        await sleep(pollMs);
      }
      entry.state = stateName;
    }
  } catch (err) {
    return {
      applied: false,
      partial: results.length > 0,
      tier: payload.tier,
      title: payload.title,
      setId,
      results,
      error: String(err.message || err),
      advice: 'Records already created cannot be deleted by this plugin. Check the set in App Store Connect before retrying.',
    };
  }
  const failed = results.filter((r) => r.state !== 'COMPLETE');
  return { applied: failed.length === 0, tier: payload.tier, title: payload.title, setId, results, notComplete: failed.length ? failed.map((r) => r.file) : undefined };
}

// ---- removing screenshots from a draft (the one delete that is allowed) ----

export async function prepareClearScreenshots(deps, { appId, version, locale = 'en-US', displayType, keepFirst = 0, platform = 'IOS' }) {
  if (!displayType) throw new Error('Pass displayType, e.g. APP_IPHONE_67.');
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'editable' });
  const state = v.appStoreState || v.appVersionState;
  if (!EDITABLE_VERSION_STATES.has(state)) throw new Error(`Version ${v.versionString} is ${state}; only a draft version's screenshots can be removed.`);
  const locs = list(await deps.get(`/v1/appStoreVersions/${enc(v.id)}/appStoreVersionLocalizations?limit=50`));
  const loc = locs.find((l) => l.locale === locale);
  if (!loc) throw new Error(`Version ${v.versionString} has no ${locale} localization.`);
  const sb = await deps.get(`/v1/appStoreVersionLocalizations/${enc(loc.id)}/appScreenshotSets?include=appScreenshots&limit=50`);
  const set = (sb.data || []).find((s) => s.attributes?.screenshotDisplayType === displayType);
  const ids = (set?.relationships?.appScreenshots?.data || []).map((r) => r.id);
  if (!set || ids.length === 0) throw new Error(`There are no ${displayType} screenshots in ${locale} to remove.`);
  const doomed = ids.slice(Math.max(0, keepFirst));
  if (doomed.length === 0) throw new Error(`keepFirst (${keepFirst}) keeps all ${ids.length} screenshots; nothing to remove.`);
  const plan = await preparePlan({
    title: `Remove ${doomed.length} ${displayType} screenshot(s) from ${v.versionString} (${locale})`,
    steps: doomed.map((id, i) => ({ label: `Remove screenshot ${keepFirst + i + 1} of ${ids.length} (${id})`, method: 'DELETE', path: '/v1/appScreenshots/{id}', pathParams: { id } })),
    deps,
  });
  return { ...plan, version: v.versionString, versionState: state, locale, displayType, willKeep: Math.max(0, keepFirst), note: 'Removed screenshots can be uploaded again. Nothing else on the version is touched.' };
}
