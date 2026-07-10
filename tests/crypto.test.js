import test from 'node:test';
import assert from 'node:assert/strict';
import {
  array_buffer_to_base64,
  base64_to_array_buffer,
  generate_salt,
  generate_iv,
  derive_key_from_password,
  encrypt,
  decrypt,
  export_key,
  import_key,
  OLD_ITERATIONS,
  CURRENT_ITERATIONS
} from '../common/crypto.js';

test('Base64 ArrayBuffer round-trip conversion', () => {
  const original = new Uint8Array([0, 1, 127, 128, 254, 255]).buffer;
  const b64 = array_buffer_to_base64(original);
  const recovered = base64_to_array_buffer(b64);
  assert.deepEqual(new Uint8Array(recovered), new Uint8Array(original));
});

test('generate_salt and generate_iv produce correct lengths', () => {
  const salt = generate_salt();
  const iv = generate_iv();
  assert.equal(salt.byteLength, 16);
  assert.equal(iv.byteLength, 12);
});

test('PBKDF2 key derivation and AES-256-GCM encryption/decryption round-trip', async () => {
  const password = 'SuperSecretMasterPassword2026!';
  const salt = generate_salt();
  const key = await derive_key_from_password(password, salt, CURRENT_ITERATIONS);

  const plaintext = 'aegis-verification-string';
  const encrypted = await encrypt(plaintext, key);

  assert.ok(encrypted.iv);
  assert.ok(encrypted.ciphertext);

  const decrypted = await decrypt(encrypted, key);
  assert.equal(decrypted, plaintext);
});

test('AES-256-GCM authentication tag mismatch rejects wrong password key', async () => {
  const salt = generate_salt();
  const correctKey = await derive_key_from_password('CorrectPassword', salt, 1000);
  const wrongKey = await derive_key_from_password('WrongPassword', salt, 1000);

  const encrypted = await encrypt('Sensitive Tab Session Data', correctKey);

  await assert.rejects(
    async () => {
      await decrypt(encrypted, wrongKey);
    },
    (err) => err.name === 'OperationError'
  );
});

test('CryptoKey export and import preserves AES-GCM decryption ability', async () => {
  const salt = generate_salt();
  const key = await derive_key_from_password('TestPassword', salt, 1000);
  const encrypted = await encrypt('Hello Zero-Knowledge World', key);

  const rawBuffer = await export_key(key);
  const reimportedKey = await import_key(rawBuffer);

  const decrypted = await decrypt(encrypted, reimportedKey);
  assert.equal(decrypted, 'Hello Zero-Knowledge World');
});
