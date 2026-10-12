// Google Play store-listing images (icon, feature graphic, screenshots). Uploads add images; a
// REPLACE clears one image set and uploads the new images inside the same edit. Everything happens
// inside ONE Play edit, committed all-or-nothing, so the listing is never left half-empty.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentFeatures } from './rules.js';
import { toLocalTime } from './util.js';

const APP = '/androidpublisher/v3/applications';
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const IMAGE_TYPES = {
  icon: { max: 1, exact: [512, 512], maxBytes: 1024 * 1024, single: true },
  featureGraphic: { max: 1, exact: [1024, 500], maxBytes: 15 * 1024 * 1024, single: true },
  phoneScreenshots: { max: 8, screenshot: true, maxBytes: 8 * 1024 * 1024 },
  sevenInchScreenshots: { max: 8, screenshot: true, maxBytes: 8 * 1024 * 1024 },
  tenInchScreenshots: { max: 8, screenshot: true, maxBytes: 8 * 1024 * 1024 },
  tvBanner: { max: 1, exact: [1280, 720], maxBytes: 15 * 1024 * 1024, single: true },
  tvScreenshots: { max: 8, screenshot: true, maxBytes: 8 * 1024 * 1024 },
  wearScreenshots: { max: 8, screenshot: true, maxBytes: 8 * 1024 * 1024 },
};

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

export function inspectImage(p, rule, imageType) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`"${p}" must be a full file path.`);
  if (!/\.(png|jpe?g)$/i.test(p)) throw new Error(`${path.basename(p)}: only PNG or JPEG images are accepted.`);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(`${p} does not exist.`);
  }
  if (!st.isFile() || st.size === 0) throw new Error(`${p} is not a usable file.`);
  if (st.size > rule.maxBytes) throw new Error(`${path.basename(p)} is ${(st.size / 1048576).toFixed(1)} MB; ${imageType} images may be at most ${rule.maxBytes / 1048576} MB.`);
  const buf = fs.readFileSync(p);
  const d = imageSize(buf);
  if (!d) throw new Error(`${path.basename(p)} does not look like a valid PNG or JPEG.`);
  if (rule.exact && (d.width !== rule.exact[0] || d.height !== rule.exact[1])) {
    throw new Error(`${path.basename(p)} is ${d.width}x${d.height}; a ${imageType} must be exactly ${rule.exact[0]}x${rule.exact[1]}.`);
  }
  if (rule.screenshot) {
    const [lo, hi] = [Math.min(d.width, d.height), Math.max(d.width, d.height)];
    if (lo < 320 || hi > 3840) throw new Error(`${path.basename(p)} is ${d.width}x${d.height}; screenshots must be between 320 and 3840 pixels on each side.`);
    if (hi > lo * 2) throw new Error(`${path.basename(p)} is ${d.width}x${d.height}; the long side may be at most twice the short side.`);
  }
  return {
    path: p,
    name: path.basename(p),
    size: st.size,
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    width: d.width,
    height: d.height,
    mime: d.type === 'png' ? 'image/png' : 'image/jpeg',
  };
}

// ---- prepare ---------------------------------------------------------------

export async function prepareUploadImages(deps, { packageName, language = 'en-US', imageType, files }) {
  if (!currentFeatures().listing) {
    return { allowed: false, tier: 3, blocked: true, reason: 'The "listing" feature is switched off in your settings. Run /hypercaffium-play:setup to see or change your settings.' };
  }
  const pkg = packageName || deps.defaultPackage();
  if (!pkg || !/^[A-Za-z0-9._]+$/.test(pkg)) throw new Error('A valid packageName is required (or set defaultPackageName in the config file).');
  if (!LANG.test(language)) throw new Error(`"${language}" is not a language code like en-US.`);
  const rule = IMAGE_TYPES[imageType];
  if (!rule) throw new Error(`imageType must be one of: ${Object.keys(IMAGE_TYPES).join(', ')}.`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('Pass files: a list of full paths to PNG or JPEG images.');
  if (files.length > rule.max) throw new Error(`${imageType} takes at most ${rule.max} image(s) per upload.`);
  const inspected = files.map((f) => inspectImage(f, rule, imageType));

  const existing = await deps.withReadContext(pkg, true, async (editId) => {
    const r = await deps.get(`${APP}/${pkg}/edits/${editId}/listings/${language}/${imageType}`, {});
    return r.images || [];
  });
  if (!rule.single && existing.length + inspected.length > rule.max) {
    throw new Error(
      `${imageType} already has ${existing.length} image(s); adding ${inspected.length} would exceed ${rule.max}. Use play_replace_images to swap the whole set instead.`,
    );
  }

  const title = `Upload ${inspected.length} ${imageType} image(s) for ${language}`;
  const payload = { kind: 'images', tier: 2, title, pkg, language, imageType, files: inspected };
  const ticket = deps.store.create(payload);
  return {
    allowed: true,
    kind: 'images',
    tier: 2,
    tierReason: 'store listing images are public on Google Play as soon as the change is committed',
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    title,
    app: pkg,
    language,
    imageType,
    existingCount: existing.length,
    replacesExisting: Boolean(rule.single && existing.length),
    files: inspected.map(({ name, size, width, height }) => ({ name, size, dimensions: `${width}x${height}` })),
    committedTogether: 'All uploads happen inside ONE Play edit and are committed together, or not at all.',
    nextStep: 'Show this to the owner in plain English and wait for an explicit yes, then apply with play_apply_change.',
  };
}

// Replace a whole image set: the current images of this type and language are removed and the new
// ones uploaded, in one edit. The preview lists every image that will be removed, with its link, so
// the owner can save copies first (Google keeps no copy once the change is committed).
export async function prepareReplaceImages(deps, { packageName, language = 'en-US', imageType, files }) {
  if (!currentFeatures().listing) {
    return { allowed: false, tier: 3, blocked: true, reason: 'The "listing" feature is switched off in your settings. Run /hypercaffium-play:setup to see or change your settings.' };
  }
  const pkg = packageName || deps.defaultPackage();
  if (!pkg || !/^[A-Za-z0-9._]+$/.test(pkg)) throw new Error('A valid packageName is required (or set defaultPackageName in the config file).');
  if (!LANG.test(language)) throw new Error(`"${language}" is not a language code like en-US.`);
  const rule = IMAGE_TYPES[imageType];
  if (!rule) throw new Error(`imageType must be one of: ${Object.keys(IMAGE_TYPES).join(', ')}.`);
  if (!Array.isArray(files) || files.length === 0) throw new Error('Pass files: the full set of new images (a replace never leaves the set empty).');
  if (files.length > rule.max) throw new Error(`${imageType} takes at most ${rule.max} image(s).`);
  const inspected = files.map((f) => inspectImage(f, rule, imageType));
  if (rule.screenshot && imageType === 'phoneScreenshots' && inspected.length < 2) {
    throw new Error('Google Play needs at least 2 phone screenshots; pass 2 or more.');
  }

  const existing = await deps.withReadContext(pkg, true, async (editId) => {
    const r = await deps.get(`${APP}/${pkg}/edits/${editId}/listings/${language}/${imageType}`, {});
    return r.images || [];
  });

  const title = `Replace all ${existing.length} ${imageType} image(s) for ${language} with ${inspected.length} new one(s)`;
  const payload = { kind: 'images', replace: true, tier: 2, title, pkg, language, imageType, files: inspected, removing: existing.map((i) => i.id) };
  const ticket = deps.store.create(payload);
  return {
    allowed: true,
    kind: 'images',
    replace: true,
    tier: 2,
    tierReason: 'store listing images are public on Google Play as soon as the change is committed, and the removed images are gone for good',
    ticket: ticket.id,
    expires: toLocalTime(new Date(ticket.expiresAt).toISOString()),
    title,
    app: pkg,
    language,
    imageType,
    removing: existing.map((i) => ({ id: i.id, link: i.url })),
    adding: inspected.map(({ name, size, width, height }) => ({ name, size, dimensions: `${width}x${height}` })),
    committedTogether: 'Removing the old images and uploading the new ones happen inside ONE Play edit and are committed together, or not at all.',
    keepCopies: existing.length
      ? 'Google keeps no copy of removed images. If the owner may want them back, save them from the links above first.'
      : undefined,
    nextStep: 'Show this to the owner in plain English (how many images are removed and added) and wait for an explicit yes, then apply with play_apply_change.',
  };
}

// ---- run -------------------------------------------------------------------

export async function runImages(payload, deps) {
  const { pkg, language, imageType, files } = payload;
  let edit;
  const done = [];
  try {
    edit = await deps.send('POST', `${APP}/${pkg}/edits`, {}, {});
    // Check every file before touching anything, so a changed file never leaves an emptied set.
    for (const f of files) {
      const buf = fs.readFileSync(f.path);
      if (buf.length !== f.size || crypto.createHash('md5').update(buf).digest('hex') !== f.md5) {
        throw new Error(`${f.name} changed on disk since the preview. Prepare again.`);
      }
    }
    if (payload.replace) {
      // The set must still be exactly what the owner saw, or someone changed it in the meantime.
      const now = (await deps.get(`${APP}/${pkg}/edits/${edit.id}/listings/${language}/${imageType}`, {})).images || [];
      const ids = now.map((i) => i.id).sort().join(',');
      if (ids !== [...(payload.removing || [])].sort().join(',')) {
        throw new Error('The images on Google Play changed since the preview. Prepare the replace again.');
      }
      await deps.send('DELETE', `${APP}/${pkg}/edits/${edit.id}/listings/${language}/${imageType}`, {}, undefined);
    }
    for (const f of files) {
      const buf = fs.readFileSync(f.path);
      if (buf.length !== f.size || crypto.createHash('md5').update(buf).digest('hex') !== f.md5) {
        throw new Error(`${f.name} changed on disk since the preview. Prepare again.`);
      }
      await deps.upload({ pkg, editId: edit.id, language, imageType, bytes: buf, mime: f.mime });
      done.push(f.name);
    }
    const commit = await deps.send('POST', `${APP}/${pkg}/edits/${edit.id}:commit`, {}, undefined);
    return { applied: true, committed: true, tier: payload.tier, title: payload.title, removed: payload.replace ? payload.removing.length : 0, uploaded: done, commit };
  } catch (err) {
    if (edit?.id) await deps.send('DELETE', `${APP}/${pkg}/edits/${edit.id}`, {}, undefined).catch(() => {});
    return {
      applied: false,
      committed: false,
      tier: payload.tier,
      title: payload.title,
      uploadedBeforeFailure: done,
      error: String(err.message || err),
      advice: 'Nothing was committed: the edit was discarded, so the listing is unchanged.',
    };
  }
}
