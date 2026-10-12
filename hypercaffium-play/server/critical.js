// CRITICAL areas on Google Play: team members ("users") and customer money ("refunds"). Both start
// OFF and can only be switched on in the terminal setup menu. Every change is sensitive: previewed
// like any other, then applied only with play_apply_sensitive_change. Reading is always allowed.
// (App signing key rotation is also critical; it is rare and irreversible, so it has no dedicated tool:
// it goes through play_prepare_change with methodId appsigning.rotateAppSigningKey.)
import { currentFeatures } from './rules.js';
import { prepareChange } from './writes.js';

const V3 = '/androidpublisher/v3';
const enc = encodeURIComponent;
const off = (feature) =>
  currentFeatures()[feature]
    ? null
    : {
        allowed: false,
        tier: 3,
        blocked: true,
        reason: `The critical "${feature}" feature is off. Only the owner can switch it on, in the terminal setup menu (see play_settings for the command).`,
      };

// Per-app permissions Google accepts, with the ones that deserve a warning.
export const APP_PERMISSIONS = [
  'CAN_ACCESS_APP',
  'CAN_VIEW_NON_FINANCIAL_DATA',
  'CAN_VIEW_APP_QUALITY',
  'CAN_REPLY_TO_REVIEWS',
  'CAN_MANAGE_PUBLIC_LISTING',
  'CAN_MANAGE_DRAFT_APPS',
  'CAN_MANAGE_TRACK_USERS',
  'CAN_MANAGE_TRACK_APKS',
  'CAN_MANAGE_PUBLIC_APKS',
  'CAN_MANAGE_APP_CONTENT',
  'CAN_MANAGE_DEEPLINKS',
  'CAN_MANAGE_ORDERS',
  'CAN_VIEW_FINANCIAL_DATA',
  'CAN_MANAGE_PERMISSIONS',
];
const PERMISSION_WARNINGS = {
  CAN_MANAGE_PERMISSIONS: 'CAN_MANAGE_PERMISSIONS lets them change other people\'s access to this app.',
  CAN_MANAGE_PUBLIC_APKS: 'CAN_MANAGE_PUBLIC_APKS lets them release to production.',
  CAN_MANAGE_ORDERS: 'CAN_MANAGE_ORDERS lets them refund and cancel customer purchases.',
  CAN_VIEW_FINANCIAL_DATA: 'CAN_VIEW_FINANCIAL_DATA shows revenue and payouts.',
};
function checkPermissions(perms) {
  if (!Array.isArray(perms) || !perms.length) throw new Error(`appPermissions must list one or more of: ${APP_PERMISSIONS.join(', ')}.`);
  const bad = perms.filter((p) => !APP_PERMISSIONS.includes(p));
  if (bad.length) throw new Error(`Unknown permission(s): ${bad.join(', ')}.`);
  return perms.map((p) => PERMISSION_WARNINGS[p]).filter(Boolean);
}

function developer(deps) {
  const id = deps.developerId();
  if (!/^[0-9]{5,25}$/.test(id || '')) {
    throw new Error('Team tools need your Play developer account ID: the long number after /developers/ in the Play Console web address. Save it with play_save_settings (developerId).');
  }
  return `developers/${id}`;
}

// ---- users -----------------------------------------------------------------

export async function teamOverview(deps) {
  const dev = developer(deps);
  const body = await deps.get(`${V3}/${dev}/users`, { pageSize: 200 });
  return {
    members: (body.users || []).map((u) => ({
      email: u.email,
      accessState: u.accessState,
      accountPermissions: u.developerAccountPermissions || [],
      apps: (u.grants || []).map((g) => ({ app: g.packageName, permissions: g.appLevelPermissions })),
      expires: u.expirationTime,
    })),
  };
}

async function findUser(deps, email) {
  const t = await teamOverview(deps);
  return t.members.find((m) => String(m.email).toLowerCase() === String(email || '').toLowerCase());
}

export async function prepareInviteUser(deps, { email, appPermissions, packageName }) {
  const blocked = off('users');
  if (blocked) return blocked;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('Pass a valid email address.');
  const warnings = checkPermissions(appPermissions);
  const pkg = packageName || deps.defaultPackage();
  const dev = developer(deps);
  if (await findUser(deps, email)) throw new Error(`${email} is already on the team. Use play_set_user_app_permissions to change their access.`);
  const preview = await prepareChange({
    changes: [{ methodId: 'users.create', params: { parent: dev }, body: { email, grants: [{ packageName: pkg, appLevelPermissions: appPermissions }] } }],
    deps,
  });
  return {
    invite: `${email} with access to ${pkg} only`,
    permissions: appPermissions,
    warnings: warnings.length ? warnings : undefined,
    note: 'Google emails them an invitation. No account-wide permissions are given; access is to this app only.',
    ...preview,
  };
}

export async function prepareSetUserAppPermissions(deps, { email, appPermissions, packageName }) {
  const blocked = off('users');
  if (blocked) return blocked;
  const warnings = checkPermissions(appPermissions);
  const pkg = packageName || deps.defaultPackage();
  const dev = developer(deps);
  const user = await findUser(deps, email);
  if (!user) throw new Error(`${email} is not on the team.`);
  const existing = user.apps.find((a) => a.app === pkg);
  const change = existing
    ? { methodId: 'grants.patch', params: { name: `${dev}/users/${user.email}/grants/${pkg}`, updateMask: 'appLevelPermissions' }, body: { appLevelPermissions: appPermissions } }
    : { methodId: 'grants.create', params: { parent: `${dev}/users/${user.email}` }, body: { packageName: pkg, appLevelPermissions: appPermissions } };
  const preview = await prepareChange({ changes: [change], deps });
  return {
    member: user.email,
    app: pkg,
    permissionsNow: existing ? existing.permissions : 'no access to this app yet',
    permissionsAfter: appPermissions,
    warnings: warnings.length ? warnings : undefined,
    ...preview,
  };
}

export async function prepareRemoveUser(deps, { email }) {
  const blocked = off('users');
  if (blocked) return blocked;
  const dev = developer(deps);
  const user = await findUser(deps, email);
  if (!user) throw new Error(`${email} is not on the team.`);
  const preview = await prepareChange({ changes: [{ methodId: 'users.delete', params: { name: `${dev}/users/${user.email}` } }], deps });
  return {
    member: user.email,
    losesAccessTo: user.apps.map((a) => a.app),
    note: 'They lose access to your developer account at once.',
    ...preview,
  };
}

// ---- refunds and subscriptions ---------------------------------------------------

export async function lookupOrder(deps, { packageName, orderId }) {
  const pkg = packageName || deps.defaultPackage();
  if (!orderId) throw new Error('Pass orderId (it starts with GPA.).');
  return deps.get(`${V3}/applications/${pkg}/orders/${enc(orderId)}`, {});
}

export async function lookupSubscription(deps, { packageName, purchaseToken }) {
  const pkg = packageName || deps.defaultPackage();
  if (!purchaseToken) throw new Error('Pass purchaseToken.');
  return deps.get(`${V3}/applications/${pkg}/purchases/subscriptionsv2/tokens/${enc(purchaseToken)}`, {});
}

export async function prepareRefundOrder(deps, { packageName, orderId, revokeAccess = false }) {
  const blocked = off('refunds');
  if (blocked) return blocked;
  const pkg = packageName || deps.defaultPackage();
  if (!/^GPA\.[0-9-]+(\.\.[0-9]+)?$/.test(orderId || '')) throw new Error('orderId must look like GPA.1234-5678-9012-34567.');
  const preview = await prepareChange({
    changes: [{ methodId: 'orders.refund', params: { packageName: pkg, orderId, revoke: revokeAccess ? 'true' : 'false' } }],
    deps,
  });
  return {
    order: orderId,
    customerImpact: [
      'The customer gets their money back for this order. This cannot be undone.',
      revokeAccess
        ? 'Their access is also REVOKED at once (for a subscription: it ends now).'
        : 'Their access is NOT revoked: they keep what they bought (for a subscription: it runs to the end of the period, then stops renewing only if it was cancelled).',
    ],
    ...preview,
  };
}

export async function prepareRevokeSubscription(deps, { packageName, purchaseToken, refund = 'full' }) {
  const blocked = off('refunds');
  if (blocked) return blocked;
  const pkg = packageName || deps.defaultPackage();
  if (!purchaseToken) throw new Error('Pass purchaseToken (from the customer\'s receipt or your subscription backend).');
  if (!['full', 'prorated'].includes(refund)) throw new Error('refund must be "full" or "prorated".');
  const preview = await prepareChange({
    changes: [
      {
        methodId: 'purchases.subscriptionsv2.revoke',
        params: { packageName: pkg, token: purchaseToken },
        body: { revocationContext: refund === 'full' ? { fullRefund: {} } : { proratedRefund: {} } },
      },
    ],
    deps,
  });
  return {
    customerImpact: [
      'The subscription ends NOW and the customer loses access immediately.',
      refund === 'full' ? 'They are refunded the full amount of the current period.' : 'They are refunded the unused part of the current period.',
      'This cannot be undone.',
    ],
    ...preview,
  };
}
