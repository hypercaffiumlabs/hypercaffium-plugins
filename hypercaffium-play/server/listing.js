// Google Play: review replies and store-listing text. Each only PREPARES a previewed, ticketed change.
import { prepareChange } from './writes.js';

function pkgOf(deps, packageName) {
  const pkg = packageName || deps.defaultPackage();
  if (!pkg || !/^[A-Za-z0-9._]+$/.test(pkg)) throw new Error('A valid packageName is required (or set defaultPackageName in the config file).');
  return pkg;
}

// ---- review replies --------------------------------------------------------

export const REPLY_MAX = 350; // Google Play's limit

export async function prepareReplyToReview(deps, { packageName, reviewId, text }) {
  const pkg = pkgOf(deps, packageName);
  if (!reviewId) throw new Error('Pass reviewId (from play_list_reviews).');
  if (typeof text !== 'string' || !text.trim()) throw new Error('The reply needs text.');
  if (text.length > REPLY_MAX) throw new Error(`The reply is ${text.length} characters; Google Play allows at most ${REPLY_MAX}.`);
  const preview = await prepareChange({
    changes: [{ methodId: 'reviews.reply', params: { reviewId, packageName: pkg }, body: { replyText: text } }],
    deps,
  });
  if (!preview.allowed) return preview;
  const before = preview.changes?.[0]?.before;
  const user = before?.comments?.find((c) => c.userComment)?.userComment;
  const dev = before?.comments?.find((c) => c.developerComment)?.developerComment;
  return {
    ...preview,
    review: user ? { stars: user.starRating, text: user.text, appVersionName: user.appVersionName } : undefined,
    existingReply: dev?.text ?? null,
    willBePublic: 'This reply is visible to everyone on Google Play, under the developer name.',
    note: dev ? 'Google replaces the existing reply with this one.' : undefined,
  };
}

// ---- listing text ----------------------------------------------------------

export const LISTING_LIMITS = { title: 30, shortDescription: 80, fullDescription: 4000 };
const LISTING_FIELDS = ['title', 'shortDescription', 'fullDescription', 'video'];

export function checkListingFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new Error(`Provide at least one field: ${LISTING_FIELDS.join(', ')}.`);
  for (const [k, v] of entries) {
    if (!LISTING_FIELDS.includes(k)) throw new Error(`Unknown field "${k}". Allowed: ${LISTING_FIELDS.join(', ')}.`);
    if (typeof v !== 'string') throw new Error(`"${k}" must be text.`);
    if (LISTING_LIMITS[k] && v.length > LISTING_LIMITS[k]) throw new Error(`"${k}" is ${v.length} characters; Google Play allows at most ${LISTING_LIMITS[k]}.`);
    if (k === 'title' && !v.trim()) throw new Error('The title cannot be empty.');
    if (k === 'video' && v !== '' && !/^https:\/\/\S+$/.test(v)) throw new Error('video must be a full https:// address.');
  }
  return Object.fromEntries(entries);
}

export async function prepareEditListing(deps, { packageName, language = 'en-US', fields }) {
  const pkg = pkgOf(deps, packageName);
  const attrs = checkListingFields(fields);
  const preview = await prepareChange({
    changes: [{ methodId: 'edits.listings.patch', params: { language, packageName: pkg }, body: attrs }],
    deps,
  });
  if (!preview.allowed) return preview;
  return {
    ...preview,
    language,
    willBePublic: 'Listing text goes live on Google Play as soon as the change is committed.',
  };
}
