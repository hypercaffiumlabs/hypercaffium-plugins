process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareChangeUser,
  prepareDeleteProfile,
  prepareInviteUser,
  prepareRegisterDevice,
  prepareRemoveUser,
  prepareRevokeCertificate,
  teamOverview,
} from './critical.js';
import { setFeatureSource } from './rules.js';
import { applyChange, TicketStore } from './writes.js';

const res = (type, id, attributes = {}) => ({ id, type, attributes });
function fake() {
  const calls = [];
  const routes = {
    'GET /v1/apps': { data: [res('apps', 'A1', { name: 'App' })] },
    'GET /v1/users': {
      data: [
        res('users', 'U0', { firstName: 'Owner', lastName: 'One', username: 'owner@example.com', roles: ['ACCOUNT_HOLDER', 'ADMIN'] }),
        res('users', 'U1', { firstName: 'Pat', lastName: 'Lee', username: 'pat@example.com', roles: ['DEVELOPER'], allAppsVisible: false }),
      ],
    },
    'GET /v1/users/U1': { data: res('users', 'U1', { roles: ['DEVELOPER'] }) },
    'GET /v1/userInvitations': { data: [res('userInvitations', 'I1', { email: 'sam@example.com', roles: ['MARKETING'], expirationDate: '2026-10-20T00:00:00Z' })] },
    'GET /v1/userInvitations/I1': { data: res('userInvitations', 'I1', {}) },
    'GET /v1/certificates/C1': { data: res('certificates', 'C1', { displayName: 'Dist', certificateType: 'DISTRIBUTION', expirationDate: '2027-01-01T00:00:00Z' }) },
    'GET /v1/profiles/P1': { data: res('profiles', 'P1', { name: 'App Store profile', profileType: 'IOS_APP_STORE' }) },
  };
  const handle = (method, p) => {
    const key = `${method} ${p.split('?')[0]}`;
    if (key in routes) return routes[key];
    if (method !== 'GET') return { data: res('x', 'new') };
    throw new Error(`fake: no route for ${key}`);
  };
  return {
    calls,
    store: new TicketStore(),
    writesEnabled: () => true,
    get: async (p) => handle('GET', p),
    send: async (method, p, _q, body) => {
      calls.push({ method, path: p, body });
      return handle(method, p);
    },
  };
}
afterEach(() => setFeatureSource(() => ({})));

test('team and signing changes are refused while their critical features are off (the default)', async () => {
  const d = fake();
  for (const r of [
    await prepareInviteUser(d, { email: 'a@example.com', firstName: 'A', lastName: 'B', roles: ['DEVELOPER'] }),
    await prepareRemoveUser(d, { email: 'pat@example.com' }),
    await prepareRegisterDevice(d, { name: 'iPad', udid: '00008101-001A2B3C4D5E6F70' }),
    await prepareRevokeCertificate(d, { certificateId: 'C1' }),
  ]) {
    assert.equal(r.allowed, false);
    assert.match(r.reason, /terminal setup menu/);
  }
  const t = await teamOverview(d);
  assert.equal(t.members.length, 2, 'reading is always allowed');
});

test('invite: sensitive Tier 2, only this app by default, warns about powerful roles, refuses ACCOUNT_HOLDER', async () => {
  setFeatureSource(() => ({ users: true }));
  const d = fake();
  const p = await prepareInviteUser(d, { email: 'a@example.com', firstName: 'A', lastName: 'B', roles: ['ADMIN'] });
  assert.equal(p.allowed, true, JSON.stringify(p));
  assert.equal(p.tier, 2);
  assert.equal(p.sensitive, true);
  assert.deepEqual(p.apps, ['A1']);
  assert.match(p.warnings.join(' '), /ADMIN can manage the whole team/);
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /asc_apply_sensitive_change/);
  await applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d });
  assert.deepEqual(d.calls[0].body.data.relationships.visibleApps.data, [{ type: 'apps', id: 'A1' }]);
  await assert.rejects(prepareInviteUser(d, { email: 'a@example.com', firstName: 'A', lastName: 'B', roles: ['ACCOUNT_HOLDER'] }), /cannot be given/);
});

test('change and remove: the Account Holder is protected; a pending invitation can be cancelled', async () => {
  setFeatureSource(() => ({ users: true }));
  const d = fake();
  await assert.rejects(prepareChangeUser(d, { email: 'owner@example.com', roles: ['DEVELOPER'] }), /Account Holder/);
  await assert.rejects(prepareRemoveUser(d, { email: 'owner@example.com' }), /Account Holder/);
  const change = await prepareChangeUser(d, { email: 'pat@example.com', roles: ['APP_MANAGER'] });
  assert.equal(change.sensitive, true);
  const remove = await prepareRemoveUser(d, { email: 'PAT@example.com' });
  assert.equal(remove.sensitive, true);
  await applyChange({ ticketId: remove.ticket, sensitiveTool: true, deps: d });
  assert.deepEqual([d.calls.at(-1).method, d.calls.at(-1).path], ['DELETE', '/v1/users/U1']);
  const cancel = await prepareRemoveUser(d, { email: 'sam@example.com' });
  assert.match(cancel.invitation, /sam@example.com/);
  await assert.rejects(prepareRemoveUser(d, { email: 'nobody@example.com' }), /neither on the team nor invited/);
});

test('signing: revoking and deleting carry an EAS warning, are sensitive, and need the signing feature', async () => {
  setFeatureSource(() => ({ signing: true }));
  const d = fake();
  const r = await prepareRevokeCertificate(d, { certificateId: 'C1' });
  assert.equal(r.sensitive, true);
  assert.match(r.warning, /cannot be undone.*EAS/s);
  const p = await prepareDeleteProfile(d, { profileId: 'P1' });
  assert.equal(p.sensitive, true);
  await applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d });
  assert.deepEqual([d.calls[0].method, d.calls[0].path], ['DELETE', '/v1/profiles/P1']);
  const dev = await prepareRegisterDevice(d, { name: 'Test iPad', udid: '00008101-001A2B3C4D5E6F70' });
  assert.equal(dev.sensitive, true);
  await assert.rejects(prepareRegisterDevice(d, { name: 'x', udid: 'nope' }), /UDID/);
  setFeatureSource(() => ({ signing: true, users: false }));
  assert.equal((await prepareRemoveUser(d, { email: 'pat@example.com' })).allowed, false, 'signing on does not unlock users');
});
