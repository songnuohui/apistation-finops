import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SupplierCredentialVault, constantTimeEqual, maskSecret, totpCode,
} from '../src/services/supplier-credentials.mjs';

const encryptionSecret = 'a5'.repeat(32);

test('supplier credential vault encrypts, authenticates, and fingerprints credentials', () => {
  const vault = new SupplierCredentialVault(encryptionSecret);
  const credentials = { accessToken: 'portal-token', apiKey: 'sk-secret' };
  const encrypted = vault.encrypt(credentials);

  assert.equal(vault.available, true);
  assert.match(encrypted, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(vault.decrypt(encrypted), credentials);
  assert.notEqual(vault.encrypt(credentials), encrypted);
  assert.equal(vault.fingerprint('sk-secret'), vault.fingerprint('sk-secret'));
  assert.notEqual(vault.fingerprint('sk-secret'), vault.fingerprint('other-secret'));
  assert.throws(() => vault.decrypt(`${encrypted.slice(0, -1)}x`));
});

test('supplier credential vault requires a valid 32-byte key', () => {
  const unavailable = new SupplierCredentialVault('');
  assert.equal(unavailable.available, false);
  assert.throws(() => unavailable.encrypt({ accessToken: 'token' }), { statusCode: 503 });
  assert.throws(() => new SupplierCredentialVault('not-a-32-byte-key'), /exactly 32 bytes/);
});

test('secret masking, TOTP, and constant-time comparison have stable behavior', () => {
  assert.equal(maskSecret('abcdefghijk'), 'abcde...hijk');
  assert.equal(maskSecret('12345678'), '12****78');
  assert.equal(maskSecret(''), '');
  assert.equal(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('same', 'different'), false);
});
