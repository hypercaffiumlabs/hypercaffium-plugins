// The safety guard. In this phase the server may ONLY make these kinds of request:
//   GET    any read under /androidpublisher/v3/...
//   POST   /androidpublisher/v3/applications/{pkg}/edits               (open an EMPTY, temporary edit)
//   DELETE /androidpublisher/v3/applications/{pkg}/edits/{editId}      (throw that edit away)
// Everything else, including ":commit", uploads, track updates and review replies, is refused
// before it leaves this machine. Phase 2b replaces this with a preview-and-confirm gate.
import { currentFeatures } from './rules.js';

const V3 = '/androidpublisher/v3/';
const SAFE_PATH = /^\/androidpublisher\/v3\/[A-Za-z0-9_\-/:.%~]+$/;
const PKG = '[A-Za-z0-9._]+';
const EDIT_ID = '[A-Za-z0-9_\\-]+';
const CREATE_EDIT = new RegExp(`^${V3}applications/${PKG}/edits$`);
const DELETE_EDIT = new RegExp(`^${V3}applications/${PKG}/edits/${EDIT_ID}$`);
// Action suffixes that publish or validate; never acceptable on a "read".
const ACTION_SUFFIX = /:(commit|validate|upload|publish)$/i;

// ---- the WRITE guard -------------------------------------------------------
// Used only by the apply path (after a valid ticket). Even then, writes may only touch
// /applications/{pkg}/..., commit goes through the exact ":commit" action, and DELETE may only
// discard an edit. Access control (users, grants) is not reachable at all.
const APP_PATH = new RegExp(`^${V3}applications/${PKG}/[A-Za-z0-9_\\-/:.%~]+$`);
const COMMIT = new RegExp(`^${V3}applications/${PKG}/edits/${EDIT_ID}:commit$`);

// The ONE upload endpoint the plugin may use: a listing image into an open edit.
const UPLOAD_IMAGE = new RegExp(
  `^/upload${V3}applications/${PKG}/edits/${EDIT_ID}/listings/[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*/(icon|featureGraphic|phoneScreenshots|sevenInchScreenshots|tenInchScreenshots|tvBanner|tvScreenshots|wearScreenshots)$`,
);

// Actions on customer money or purchases are refused at the path level too, so the block does not
// depend only on the method-id rules in rules.js.
const PURCHASE_ACTIONS = /(:(refund|revoke|cancel|defer|consume|acknowledge))|\/(orders|purchases|externalTransactions|voidedpurchases)(\/|:|$)/i;

// App bundle and mapping-file uploads into an open edit (only with the "uploads" feature on).
const UPLOAD_BUNDLE = new RegExp(`^/upload${V3}applications/${PKG}/edits/${EDIT_ID}/bundles$`);
const UPLOAD_MAPPING = new RegExp(`^/upload${V3}applications/${PKG}/edits/${EDIT_ID}/apks/[0-9]+/deobfuscationFiles/(proguard|nativeCode)$`);

// Google's price converter: a POST that only calculates (it changes nothing), used by price previews.
const CONVERT_PRICES = new RegExp(`^${V3}applications/${PKG}/pricing:convertRegionPrices$`);

// The ONE delete of listing content the plugin may send: clearing one image set of one language
// INSIDE an open edit, as the first step of replacing it. The edit is committed together with the
// new uploads or discarded, so the listing is never left half-empty.
const IMAGE_SET = new RegExp(
  `^${V3}applications/${PKG}/edits/${EDIT_ID}/listings/[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*/(icon|featureGraphic|phoneScreenshots|sevenInchScreenshots|tenInchScreenshots|tvBanner|tvScreenshots|wearScreenshots)$`,
);

// App signing key enrollment and rotation (rotation cannot be undone).
const SIGNING = /\/appSigning(:|\/|$)/i;
// Developer-account users and their per-app grants live outside /applications/.
const DEV_USERS = new RegExp(`^${V3}developers/[0-9]+/users(/[^/]+(/grants(/[^/]+)?)?)?$`);

// Critical areas are refused here unless their feature is switched on, so the block does not depend
// only on the method-id rules in rules.js.
export function assertWriteAllowed(method, pathname, features = currentFeatures()) {
  if (pathname.split('/').some((seg) => seg === '.' || seg === '..' || /^%2e(%2e)?$/i.test(seg))) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} contains a dot-segment.`);
  }
  if (PURCHASE_ACTIONS.test(pathname) && !features.refunds) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} acts on customer purchases or orders (the "refunds" feature is off).`);
  }
  if (SIGNING.test(pathname) && !features.signing) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} changes app signing (the "signing" feature is off).`);
  }
  let allowed = false;
  if (method === 'POST' && (CREATE_EDIT.test(pathname) || COMMIT.test(pathname) || UPLOAD_IMAGE.test(pathname))) allowed = true;
  else if (method === 'POST' && (UPLOAD_BUNDLE.test(pathname) || UPLOAD_MAPPING.test(pathname))) {
    if (!features.uploads) throw new Error(`Blocked by safety guard: ${method} ${pathname} uploads an app file (the "uploads" feature is off).`);
    allowed = true;
  }
  else if (['POST', 'PUT', 'PATCH'].includes(method)) {
    allowed =
      (APP_PATH.test(pathname) && !/\/users(\/|$)|\/grants(\/|$)/.test(pathname)) || (Boolean(features.users) && DEV_USERS.test(pathname));
  }
  // discard an edit, clear one image set inside it, or (users feature on) remove a team member or their access to one app
  else if (method === 'DELETE') allowed = DELETE_EDIT.test(pathname) || IMAGE_SET.test(pathname) || (Boolean(features.users) && DEV_USERS.test(pathname));
  if (!allowed) throw new Error(`Blocked by safety guard: ${method} ${pathname} is not an allowed change.`);
}

export function assertAllowed(method, pathname) {
  // Dot-segments could walk out of /androidpublisher/v3/ once the URL is normalized.
  if (pathname.split('/').some((seg) => seg === '.' || seg === '..' || seg.toLowerCase() === '%2e' || seg.toLowerCase() === '%2e%2e')) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} contains a dot-segment.`);
  }
  let allowed = false;
  if (method === 'GET') allowed = SAFE_PATH.test(pathname) && !ACTION_SUFFIX.test(pathname);
  else if (method === 'POST') allowed = CREATE_EDIT.test(pathname) || CONVERT_PRICES.test(pathname);
  else if (method === 'DELETE') allowed = DELETE_EDIT.test(pathname);
  if (!allowed) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} is not a read-only request.`);
  }
}
