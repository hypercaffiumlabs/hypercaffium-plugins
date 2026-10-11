import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWriteAllowed } from './guard.js';

test('the write guard refuses actions on purchases and orders at the path level', () => {
  const pkg = '/androidpublisher/v3/applications/com.example.app';
  for (const p of [
    `${pkg}/orders:refund`,
    `${pkg}/purchases/subscriptionsv2/tokens/abc:revoke`,
    `${pkg}/purchases/products/sku/tokens/abc:consume`,
    `${pkg}/externalTransactions/xyz:refund`,
    `${pkg}/purchases/voidedpurchases`,
  ]) {
    assert.throws(() => assertWriteAllowed('POST', p), /Blocked by safety guard/, p);
  }
});

test('ordinary listing and track changes still pass the write guard', () => {
  const pkg = '/androidpublisher/v3/applications/com.example.app';
  assert.doesNotThrow(() => assertWriteAllowed('PUT', `${pkg}/edits/123/tracks/production`));
  assert.doesNotThrow(() => assertWriteAllowed('PUT', `${pkg}/edits/123/listings/en-US`));
  assert.doesNotThrow(() => assertWriteAllowed('POST', `${pkg}/edits/123:commit`));
});
