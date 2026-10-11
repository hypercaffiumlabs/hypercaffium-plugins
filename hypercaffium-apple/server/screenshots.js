// Screenshot upload to a DRAFT App Store version. Apple's flow: reserve a slot, PUT the bytes to the
// URLs Apple returns, commit with an MD5 checksum, then wait for processing. Only ADDS screenshots:
// replacing old ones needs deletes, which stay blocked until the owner approves a narrow rule.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EDITABLE_VERSION_STATES } from './rules.js';
import { findOperation } from './plans.js';
import { findVersion, list, resolveApp } from './release.js';
import { preparePlan } from './plans.js';
import { validateBody } from './spec.js';
import { toLocalTime } from './util.js';

export const MAX_PER_SET = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
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

// ---- prepare ---------------------------------------------------------------

export async function prepareScreenshots(deps, { appId, version, locale = 'en-US', displayType, files, platform = 'IOS' }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Pass files: a list of full paths to PNG or JPEG screenshots.');
  if (files.length > MAX_PER_SET) throw new Error(`At most ${MAX_PER_SET} screenshots per set.`);
  const setOp = findOperation('POST', '/v1/appScreenshotSets');
  const typeProblems = validateBody(setOp, {
    data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: displayType }, relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: 'x' } } } },
  });
  if (typeProblems.length) throw new Error(`displayType "${displayType}" is not valid. ${typeProblems[0]}`);

  const inspected = files.map(inspectFile);
  const app = await resolveApp(deps, appId);
  const v = await findVersion(deps, { appId: app, version, platform, mode: 'editable' });
  const state = v.appStoreState || v.appVersionState;
  if (!EDITABLE_VERSION_STATES.has(state)) throw new Error(`Version ${v.versionString} is ${state}; screenshots can only be added while it is a draft.`);

  const locs = list(await deps.get(`/v1/appStoreVersions/${enc(v.id)}/appStoreVersionLocalizations?limit=50`));
  const loc = locs.find((l) => l.locale === locale);
  if (!loc) throw new Error(`Version ${v.versionString} has no ${locale} localization yet. Create it with asc_edit_listing first.`);

  const sb = await deps.get(`/v1/appStoreVersionLocalizations/${enc(loc.id)}/appScreenshotSets?include=appScreenshots&limit=50`);
  const set = (sb.data || []).find((s) => s.attributes?.screenshotDisplayType === displayType) || null;
  const existing = set ? (set.relationships?.appScreenshots?.data || []).length : 0;
  if (existing + inspected.length > MAX_PER_SET) {
    throw new Error(
      `That set already has ${existing} screenshot(s); adding ${inspected.length} would exceed ${MAX_PER_SET}. Remove old ones first with asc_clear_screenshots (a Tier 2 step that needs the owner's yes), then upload again.`,
    );
  }

  const title = `Add ${inspected.length} ${displayType} screenshot(s) to ${v.versionString} (${locale})`;
  const payload = {
    kind: 'screenshots',
    tier: 1,
    title,
    versionString: v.versionString,
    localizationId: loc.id,
    setId: set?.id || null,
    displayType,
    files: inspected,
  };
  const ticket = deps.store.create(payload);
  return {
    allowed: true,
    kind: 'screenshots',
    tier: 1,
    tierReason: 'adding screenshots to a draft version (not visible to users, nothing is deleted)',
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    title,
    version: v.versionString,
    versionState: state,
    locale,
    displayType,
    creatingNewSet: !set,
    existingInSet: existing,
    files: inspected.map(({ name, size, width, height, format }) => ({ name, size, dimensions: `${width}x${height}`, format })),
    note: 'Apple checks dimensions when processing. A wrong size shows up as FAILED for that file, with nothing public affected.',
    nextStep: 'Low risk. Apply with asc_apply_safe_change (or asc_apply_change).',
  };
}

// ---- run -------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runScreenshots(payload, deps, { fetchImpl = fetch, pollMs = 2000, pollTries = 30 } = {}) {
  const results = [];
  let setId = payload.setId;
  try {
    if (!setId) {
      const r = await deps.send('POST', '/v1/appScreenshotSets', {}, {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: payload.displayType },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: payload.localizationId } } },
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
      const created = await deps.send('POST', '/v1/appScreenshots', {}, {
        data: {
          type: 'appScreenshots',
          attributes: { fileName: f.name, fileSize: f.size },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
        },
      });
      const shotId = created.data.id;
      entry.id = shotId;
      for (const op of created.data.attributes?.uploadOperations || []) {
        const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]));
        const res = await fetchImpl(op.url, { method: op.method || 'PUT', headers, body: buf.subarray(op.offset, op.offset + op.length) });
        if (!res.ok) throw new Error(`Upload of ${f.name} failed: HTTP ${res.status}`);
      }
      await deps.send('PATCH', `/v1/appScreenshots/${enc(shotId)}`, {}, {
        data: { type: 'appScreenshots', id: shotId, attributes: { uploaded: true, sourceFileChecksum: f.md5 } },
      });
      let stateName = 'UPLOAD_COMPLETE';
      for (let i = 0; i < pollTries; i++) {
        const cur = await deps.get(`/v1/appScreenshots/${enc(shotId)}`);
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
      advice: 'Screenshot records already created cannot be deleted by this plugin. Check the set in App Store Connect before retrying.',
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
