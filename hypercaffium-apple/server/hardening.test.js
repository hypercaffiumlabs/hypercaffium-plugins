import assert from 'node:assert/strict';
import test from 'node:test';
import { assertApiUrl, ascGet } from './client.js';

test('credentials are never sent outside Apple\'s API host', async () => {
  assert.throws(() => assertApiUrl(new URL('https://evil.example/v1/apps')), /not an App Store Connect API address/);
  assert.throws(() => assertApiUrl(new URL('https://api.appstoreconnect.apple.com/other/path')), /not an App Store Connect API address/);
  assert.doesNotThrow(() => assertApiUrl(new URL('https://api.appstoreconnect.apple.com/v1/apps')));
  // An absolute URL passed as a "path" is refused before any token is created or sent.
  await assert.rejects(() => ascGet('https://evil.example/v1/apps'), /Refusing to send credentials/);
  await assert.rejects(() => ascGet('//evil.example/v1/apps'), /Refusing to send credentials/);
});
