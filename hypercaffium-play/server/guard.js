// The safety guard. In this phase the server may ONLY make these kinds of request:
//   GET    any read under /androidpublisher/v3/...
//   POST   /androidpublisher/v3/applications/{pkg}/edits               (open an EMPTY, temporary edit)
//   DELETE /androidpublisher/v3/applications/{pkg}/edits/{editId}      (throw that edit away)
// Everything else, including ":commit", uploads, track updates and review replies, is refused
// before it leaves this machine. Phase 2b replaces this with a preview-and-confirm gate.
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

export function assertWriteAllowed(method, pathname) {
  if (pathname.split('/').some((seg) => seg === '.' || seg === '..' || /^%2e(%2e)?$/i.test(seg))) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} contains a dot-segment.`);
  }
  if (PURCHASE_ACTIONS.test(pathname)) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} acts on customer purchases or orders.`);
  }
  let allowed = false;
  if (method === 'POST' && (CREATE_EDIT.test(pathname) || COMMIT.test(pathname) || UPLOAD_IMAGE.test(pathname))) allowed = true;
  else if (['POST', 'PUT', 'PATCH'].includes(method)) allowed = APP_PATH.test(pathname) && !/\/users(\/|$)|\/grants(\/|$)/.test(pathname);
  else if (method === 'DELETE') allowed = DELETE_EDIT.test(pathname); // only to discard an edit
  if (!allowed) throw new Error(`Blocked by safety guard: ${method} ${pathname} is not an allowed change.`);
}

export function assertAllowed(method, pathname) {
  // Dot-segments could walk out of /androidpublisher/v3/ once the URL is normalized.
  if (pathname.split('/').some((seg) => seg === '.' || seg === '..' || seg.toLowerCase() === '%2e' || seg.toLowerCase() === '%2e%2e')) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} contains a dot-segment.`);
  }
  let allowed = false;
  if (method === 'GET') allowed = SAFE_PATH.test(pathname) && !ACTION_SUFFIX.test(pathname);
  else if (method === 'POST') allowed = CREATE_EDIT.test(pathname);
  else if (method === 'DELETE') allowed = DELETE_EDIT.test(pathname);
  if (!allowed) {
    throw new Error(`Blocked by safety guard: ${method} ${pathname} is not a read-only request.`);
  }
}
