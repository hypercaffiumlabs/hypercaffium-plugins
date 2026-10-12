process.env.HYPERCAFFIUM_TIMEZONE ??= 'America/New_York';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareInviteUser,
  prepareRefundOrder,
  prepareRemoveUser,
  prepareRevokeSubscription,
  prepareSetUserAppPermissions,
  teamOverview,
} from './critical.js';
import { assertWriteAllowed } from './guard.js';
import { setFeatureSource, currentFeatures } from './rules.js';
import { applyChange, TicketStore } from './writes.js';

const PKG = 'com.example.app';
function fake({ developerId = '1234567890' } = {}) {
  const calls = [];
  return {
    calls,
    store: new TicketStore(),
    defaultPackage: () => PKG,
    developerId: () => developerId,
    writesEnabled: () => true,
    withReadContext: async (_p, needsEdit, fn) => fn(needsEdit ? 'E0' : null),
    get: async (p) => {
      if (p.endsWith('/developers/1234567890/users')) {
        return {
          users: [
            { email: 'pat@example.com', accessState: 'ACCESS_GRANTED', grants: [{ packageName: PKG, appLevelPermissions: ['CAN_ACCESS_APP'] }] },
            { email: 'sam@example.com', accessState: 'ACCESS_GRANTED', grants: [] },
          ],
        };
      }
      if (p.includes('/orders/')) return { orderId: 'GPA.1234-5678-9012-34567', state: 'PROCESSED' };
      return {};
    },
    // Real sends go through the guard, like the server does.
    send: async (method, p, query, body) => {
      assertWriteAllowed(method, p, currentFeatures());
      calls.push([method, p, query, body]);
      return {};
    },
  };
}
afterEach(() => setFeatureSource(() => ({})));

test('team and refund changes are refused while their critical features are off (the default)', async () => {
  const d = fake();
  for (const r of [
    await prepareInviteUser(d, { email: 'new@example.com', appPermissions: ['CAN_ACCESS_APP'] }),
    await prepareRemoveUser(d, { email: 'pat@example.com' }),
    await prepareRefundOrder(d, { orderId: 'GPA.1234-5678-9012-34567' }),
    await prepareRevokeSubscription(d, { purchaseToken: 'tok' }),
  ]) {
    assert.equal(r.allowed, false);
    assert.match(r.reason, /terminal setup menu/);
  }
  assert.equal((await teamOverview(d)).members.length, 2, 'reading is always allowed');
});

test('team tools explain how to find the developer ID when it is missing', async () => {
  setFeatureSource(() => ({ users: true }));
  await assert.rejects(teamOverview(fake({ developerId: '' })), /after \/developers\//);
});

test('invite: this app only, warns about powerful permissions, sensitive, and passes the guard', async () => {
  setFeatureSource(() => ({ users: true }));
  const d = fake();
  const p = await prepareInviteUser(d, { email: 'new@example.com', appPermissions: ['CAN_ACCESS_APP', 'CAN_MANAGE_ORDERS'] });
  assert.equal(p.allowed, true, JSON.stringify(p));
  assert.equal(p.sensitive, true);
  assert.match(p.warnings.join(' '), /refund/);
  await assert.rejects(applyChange({ ticketId: p.ticket, deps: d }), /play_apply_sensitive_change/);
  await applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d });
  const [method, path, , body] = d.calls[0];
  assert.equal(method, 'POST');
  assert.equal(path, '/androidpublisher/v3/developers/1234567890/users');
  assert.deepEqual(body.grants, [{ packageName: PKG, appLevelPermissions: ['CAN_ACCESS_APP', 'CAN_MANAGE_ORDERS'] }]);
  assert.equal(body.developerAccountPermissions, undefined, 'no account-wide permissions');
  await assert.rejects(prepareInviteUser(d, { email: 'pat@example.com', appPermissions: ['CAN_ACCESS_APP'] }), /already on the team/);
});

test('permissions: patches an existing grant, or creates one for someone without access to this app', async () => {
  setFeatureSource(() => ({ users: true }));
  const d = fake();
  const a = await prepareSetUserAppPermissions(d, { email: 'pat@example.com', appPermissions: ['CAN_ACCESS_APP', 'CAN_REPLY_TO_REVIEWS'] });
  await applyChange({ ticketId: a.ticket, sensitiveTool: true, deps: d });
  assert.equal(d.calls[0][0], 'PATCH');
  assert.match(d.calls[0][1], /\/users\/pat%40example\.com\/grants\/com\.example\.app$/);
  assert.equal(d.calls[0][2].updateMask, 'appLevelPermissions');
  const b = await prepareSetUserAppPermissions(d, { email: 'sam@example.com', appPermissions: ['CAN_ACCESS_APP'] });
  assert.match(b.permissionsNow, /no access/);
  await applyChange({ ticketId: b.ticket, sensitiveTool: true, deps: d });
  assert.equal(d.calls[1][0], 'POST');
  assert.match(d.calls[1][1], /\/users\/sam%40example\.com\/grants$/);
});

test('remove: deletes exactly that member, through the guard', async () => {
  setFeatureSource(() => ({ users: true }));
  const d = fake();
  const p = await prepareRemoveUser(d, { email: 'PAT@example.com' });
  assert.deepEqual(p.losesAccessTo, [PKG]);
  await applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d });
  assert.deepEqual(d.calls[0].slice(0, 2), ['DELETE', '/androidpublisher/v3/developers/1234567890/users/pat%40example.com']);
  await assert.rejects(prepareRemoveUser(d, { email: 'nobody@example.com' }), /not on the team/);
});

test('refund: spells out the customer impact, sets revoke as asked, and needs the refunds feature', async () => {
  setFeatureSource(() => ({ refunds: true }));
  const d = fake();
  const keep = await prepareRefundOrder(d, { orderId: 'GPA.1234-5678-9012-34567' });
  assert.equal(keep.sensitive, true);
  assert.match(keep.customerImpact.join(' '), /NOT revoked/);
  await applyChange({ ticketId: keep.ticket, sensitiveTool: true, deps: d });
  assert.match(d.calls[0][1], /\/orders\/GPA\.1234-5678-9012-34567:refund$/);
  assert.equal(d.calls[0][2].revoke, 'false');
  const revoke = await prepareRefundOrder(d, { orderId: 'GPA.1234-5678-9012-34567', revokeAccess: true });
  assert.match(revoke.customerImpact.join(' '), /REVOKED/);
  await assert.rejects(prepareRefundOrder(d, { orderId: '12345' }), /GPA\./);
});

test('revoke subscription: ends now with the chosen refund, sensitive', async () => {
  setFeatureSource(() => ({ refunds: true }));
  const d = fake();
  const p = await prepareRevokeSubscription(d, { purchaseToken: 'tok-1', refund: 'prorated' });
  assert.equal(p.sensitive, true);
  assert.match(p.customerImpact.join(' '), /ends NOW/);
  await applyChange({ ticketId: p.ticket, sensitiveTool: true, deps: d });
  assert.match(d.calls[0][1], /subscriptionsv2\/tokens\/tok-1:revoke$/);
  assert.deepEqual(d.calls[0][3], { revocationContext: { proratedRefund: {} } });
});
