// CRITICAL areas: team members ("users") and signing assets ("signing"). Both features start OFF and
// can only be switched on in the terminal setup menu. Every change here is sensitive: it is previewed
// like any other, then applied only with asc_apply_sensitive_change. Reading is always allowed.
import { findOperation } from './plans.js';
import { list, resolveApp } from './release.js';
import { currentFeatures } from './rules.js';
import { toLocalTime } from './util.js';
import { prepareChange } from './writes.js';

const enc = encodeURIComponent;
const opFor = (method, path) => {
  const op = findOperation(method, path);
  if (!op) throw new Error(`Apple's API has no ${method} ${path}.`);
  return op;
};
const off = (feature) =>
  currentFeatures()[feature]
    ? null
    : {
        allowed: false,
        tier: 3,
        blocked: true,
        reason: `The critical "${feature}" feature is off. Only the owner can switch it on, in the terminal setup menu (see asc_settings for the command).`,
      };

export const ROLES = ['ADMIN', 'FINANCE', 'SALES', 'MARKETING', 'APP_MANAGER', 'DEVELOPER', 'ACCESS_TO_REPORTS', 'CUSTOMER_SUPPORT', 'CREATE_APPS', 'GENERATE_INDIVIDUAL_KEYS'];
const ROLE_WARNINGS = {
  ADMIN: 'ADMIN can manage the whole team, every app, agreements and API keys.',
  FINANCE: 'FINANCE can see sales, payments and tax and banking details.',
  GENERATE_INDIVIDUAL_KEYS: 'GENERATE_INDIVIDUAL_KEYS lets them create their own API keys.',
};
function checkRoles(roles) {
  if (!Array.isArray(roles) || !roles.length) throw new Error(`roles must list one or more of: ${ROLES.join(', ')}.`);
  const bad = roles.filter((r) => !ROLES.includes(r));
  if (bad.length) throw new Error(`Not allowed here: ${bad.join(', ')}. Choose from ${ROLES.join(', ')} (ACCOUNT_HOLDER cannot be given).`);
  return roles.map((r) => ROLE_WARNINGS[r]).filter(Boolean);
}

// ---- users -----------------------------------------------------------------

export async function teamOverview(deps) {
  const [users, invites] = await Promise.all([
    deps.get('/v1/users?limit=200'),
    deps.get('/v1/userInvitations?limit=200').catch(() => ({ data: [] })),
  ]);
  return {
    members: list(users).map((u) => ({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(' '), email: u.username, roles: u.roles, allApps: u.allAppsVisible })),
    pendingInvitations: list(invites).map((i) => ({ id: i.id, email: i.email, roles: i.roles, expires: toLocalTime(i.expirationDate) })),
  };
}

async function visibleAppsRel(deps, appIds) {
  if (!appIds || !appIds.length) return undefined;
  return { data: appIds.map((id) => ({ type: 'apps', id })) };
}

export async function prepareInviteUser(deps, { email, firstName, lastName, roles, allAppsVisible = false, appIds, provisioningAllowed = false }) {
  const blocked = off('users');
  if (blocked) return blocked;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('Pass a valid email address.');
  if (!firstName || !lastName) throw new Error('Pass firstName and lastName.');
  const warnings = checkRoles(roles);
  if (!allAppsVisible && !(appIds && appIds.length)) {
    appIds = [await resolveApp(deps)];
  }
  const relationships = allAppsVisible ? undefined : { visibleApps: await visibleAppsRel(deps, appIds) };
  const preview = await prepareChange({
    op: opFor('POST', '/v1/userInvitations'),
    body: {
      data: {
        type: 'userInvitations',
        attributes: { email, firstName, lastName, roles, allAppsVisible, provisioningAllowed },
        ...(relationships ? { relationships } : {}),
      },
    },
    deps,
  });
  return {
    invite: `${firstName} ${lastName} <${email}> as ${roles.join(', ')}`,
    apps: allAppsVisible ? 'ALL apps, including future ones' : appIds,
    warnings: warnings.length ? warnings : undefined,
    note: 'Apple emails them an invitation. Prefer the fewest roles and only the apps they need.',
    ...preview,
  };
}

async function findMember(deps, email) {
  const t = await teamOverview(deps);
  const lower = String(email || '').toLowerCase();
  return {
    user: t.members.find((u) => String(u.email).toLowerCase() === lower),
    invite: t.pendingInvitations.find((i) => String(i.email).toLowerCase() === lower),
  };
}

export async function prepareChangeUser(deps, { email, roles, allAppsVisible, appIds }) {
  const blocked = off('users');
  if (blocked) return blocked;
  const { user } = await findMember(deps, email);
  if (!user) throw new Error(`${email} is not on the team (pending invitations cannot be edited; cancel and re-invite).`);
  if ((user.roles || []).includes('ACCOUNT_HOLDER')) throw new Error('The Account Holder cannot be changed through the API.');
  const attributes = {};
  let warnings = [];
  if (roles) {
    warnings = checkRoles(roles);
    attributes.roles = roles;
  }
  if (allAppsVisible !== undefined) attributes.allAppsVisible = allAppsVisible;
  const relationships = appIds && appIds.length ? { visibleApps: await visibleAppsRel(deps, appIds) } : undefined;
  if (!Object.keys(attributes).length && !relationships) throw new Error('Pass roles, allAppsVisible and/or appIds to change.');
  const preview = await prepareChange({
    op: opFor('PATCH', '/v1/users/{id}'),
    pathParams: { id: user.id },
    body: { data: { type: 'users', id: user.id, attributes, ...(relationships ? { relationships } : {}) } },
    deps,
  });
  return { member: `${user.name} <${user.email}>`, rolesNow: user.roles, warnings: warnings.length ? warnings : undefined, ...preview };
}

export async function prepareRemoveUser(deps, { email }) {
  const blocked = off('users');
  if (blocked) return blocked;
  const { user, invite } = await findMember(deps, email);
  if (user) {
    if ((user.roles || []).includes('ACCOUNT_HOLDER')) throw new Error('The Account Holder cannot be removed.');
    return {
      member: `${user.name} <${user.email}> (${(user.roles || []).join(', ')})`,
      note: 'They lose access to App Store Connect at once. Their API keys, if any, keep working until revoked separately.',
      ...(await prepareChange({ op: opFor('DELETE', '/v1/users/{id}'), pathParams: { id: user.id }, deps })),
    };
  }
  if (invite) {
    return {
      invitation: `${invite.email} (${(invite.roles || []).join(', ')})`,
      ...(await prepareChange({ op: opFor('DELETE', '/v1/userInvitations/{id}'), pathParams: { id: invite.id }, deps })),
    };
  }
  throw new Error(`${email} is neither on the team nor invited.`);
}

// ---- signing -----------------------------------------------------------------

const EAS_WARNING =
  'If EAS, Xcode or fastlane manages your signing, they rely on these certificates and profiles. Changing them can make the next build or upload fail until the tool recreates them.';

export async function signingOverview(deps) {
  const [certs, profiles, devices, bundleIds] = await Promise.all([
    deps.get('/v1/certificates?limit=200'),
    deps.get('/v1/profiles?limit=200'),
    deps.get('/v1/devices?limit=200'),
    deps.get('/v1/bundleIds?limit=200'),
  ]);
  return {
    certificates: list(certs).map((c) => ({ id: c.id, name: c.displayName || c.name, type: c.certificateType, expires: toLocalTime(c.expirationDate), serial: c.serialNumber })),
    profiles: list(profiles).map((p) => ({ id: p.id, name: p.name, type: p.profileType, state: p.profileState, expires: toLocalTime(p.expirationDate) })),
    devices: list(devices).map((d) => ({ id: d.id, name: d.name, platform: d.platform, status: d.status, model: d.model })),
    bundleIds: list(bundleIds).map((b) => ({ id: b.id, identifier: b.identifier, name: b.name, platform: b.platform })),
    note: EAS_WARNING,
  };
}

export async function prepareRegisterDevice(deps, { name, udid, platform = 'IOS' }) {
  const blocked = off('signing');
  if (blocked) return blocked;
  if (!name || name.length > 50) throw new Error('Pass a device name (50 characters max).');
  if (!/^[0-9A-Fa-f-]{25,40}$/.test(udid || '')) throw new Error('That does not look like a device UDID (25 to 40 hex characters and dashes).');
  return {
    device: `${name} (${udid})`,
    note: 'Apple allows 100 devices of each type per membership year, and a registered device counts even if disabled later. Development and ad hoc profiles must be regenerated to include it.',
    ...(await prepareChange({
      op: opFor('POST', '/v1/devices'),
      body: { data: { type: 'devices', attributes: { name, udid, platform } } },
      deps,
    })),
  };
}

export async function prepareSetDeviceEnabled(deps, { deviceId, enabled }) {
  const blocked = off('signing');
  if (blocked) return blocked;
  if (typeof enabled !== 'boolean') throw new Error('Pass enabled: true or false.');
  return prepareChange({
    op: opFor('PATCH', '/v1/devices/{id}'),
    pathParams: { id: deviceId },
    body: { data: { type: 'devices', id: deviceId, attributes: { status: enabled ? 'ENABLED' : 'DISABLED' } } },
    deps,
  });
}

export async function prepareRevokeCertificate(deps, { certificateId }) {
  const blocked = off('signing');
  if (blocked) return blocked;
  const cert = await deps.get(`/v1/certificates/${enc(certificateId)}`);
  const c = cert?.data?.attributes || {};
  return {
    certificate: `${c.displayName || c.name || certificateId} (${c.certificateType || 'unknown type'}, expires ${toLocalTime(c.expirationDate)})`,
    warning: `Revoking cannot be undone. Apps already on the App Store keep working, but ${c.certificateType && /DISTRIBUTION/.test(c.certificateType) ? 'no new build can be signed or uploaded with it, and ad hoc / enterprise installs signed with it stop opening' : 'development builds signed with it stop installing'}. ${EAS_WARNING}`,
    ...(await prepareChange({ op: opFor('DELETE', '/v1/certificates/{id}'), pathParams: { id: certificateId }, deps })),
  };
}

export async function prepareDeleteProfile(deps, { profileId }) {
  const blocked = off('signing');
  if (blocked) return blocked;
  const prof = await deps.get(`/v1/profiles/${enc(profileId)}`);
  const p = prof?.data?.attributes || {};
  return {
    profile: `${p.name || profileId} (${p.profileType || 'unknown type'})`,
    warning: `Deleting cannot be undone. ${EAS_WARNING}`,
    ...(await prepareChange({ op: opFor('DELETE', '/v1/profiles/{id}'), pathParams: { id: profileId }, deps })),
  };
}
