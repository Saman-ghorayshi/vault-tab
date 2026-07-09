// Phase 7.2: unit tests for common/crypto.js
// run with: node --test test_crypto.mjs
//
// these cover the minimum cases from the plan:
//   - encrypt() then decrypt() with same key = original plaintext
//   - decrypt() with a DIFFERENT key throws
//   - array_buffer_to_base64 / base64_to_array_buffer round-trip correctly,
//     including on a large 100,000+ byte buffer (the chunked-conversion path)
//   - derive_key_from_password is deterministic for same password/salt/iterations
//   - different salts for same password produce keys that can't decrypt each other

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// load crypto.js as an ES module via data URL (it uses export).
// globalThis.crypto is webcrypto in modern Node, so no browser shim needed.
const src = readFileSync(new URL('./common/crypto.js', import.meta.url), 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
const {
  encrypt, decrypt,
  array_buffer_to_base64, base64_to_array_buffer,
  generate_salt, generate_iv,
  derive_key_from_password,
  OLD_ITERATIONS, CURRENT_ITERATIONS,
} = await import(dataUrl);

// small iteration count for tests — the real 600k would make every test take
// ~100ms+. crypto.js accepts iterations as a parameter, so we use a tiny value.
const TEST_ITERATIONS = 1000;

describe('crypto.js — AES-256-GCM encrypt/decrypt', () => {
  it('encrypt() then decrypt() returns the original plaintext', async () => {
    const salt = generate_salt();
    const key = await derive_key_from_password('correct horse battery staple', salt, TEST_ITERATIONS);
    const plaintext = 'hello, this is a secret tab group title';
    const encrypted = await encrypt(plaintext, key);
    const decrypted = await decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it('decrypt() with a different key throws', async () => {
    const salt = generate_salt();
    const key1 = await derive_key_from_password('password one', salt, TEST_ITERATIONS);
    const key2 = await derive_key_from_password('password two', salt, TEST_ITERATIONS);
    const encrypted = await encrypt('secret data', key1);

    // AES-GCM auth tag makes decrypt with wrong key throw, not return garbage.
    await assert.rejects(
      () => decrypt(encrypted, key2),
      (err) => {
        // Web Crypto throws an OperationError or similar on auth failure.
        // don't assert the exact DOMException name — just that it threw.
        assert.ok(err, 'decrypt with wrong key must throw, not return garbage');
        return true;
      }
    );
  });

  it('decrypt() with a key derived at a different iteration count throws', async () => {
    // this is the regression check from bug 1.2: bumping iterations silently
    // breaks decryption of ciphertext encrypted with the old count.
    const salt = generate_salt();
    const key_old = await derive_key_from_password('pw', salt, 310000);
    const key_new = await derive_key_from_password('pw', salt, 600000);
    const encrypted = await encrypt('data encrypted at old iterations', key_old);

    await assert.rejects(
      () => decrypt(encrypted, key_new),
      () => true,
      'decrypt with key derived at a different iteration count must fail'
    );
  });
});

describe('crypto.js — base64 round-trip', () => {
  it('round-trips a small buffer', () => {
    const original = new Uint8Array([0, 1, 2, 3, 254, 255, 128, 64, 32]);
    const b64 = array_buffer_to_base64(original.buffer);
    const decoded = new Uint8Array(base64_to_array_buffer(b64));
    assert.deepEqual(Array.from(decoded), Array.from(original));
  });

  it('round-trips a large 100,000+ byte buffer (exercises chunked conversion)', () => {
    // 100,000 bytes — the chunked-conversion path in array_buffer_to_base64
    // exists specifically to avoid the stack overflow you'd hit spreading a
    // huge typed array into String.fromCharCode.apply. this test makes sure
    // that path works and round-trips byte-for-byte.
    const size = 100003; // not a multiple of the chunk size, deliberately
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      original[i] = (i * 7 + 11) & 0xff; // pseudo-random but deterministic
    }
    const b64 = array_buffer_to_base64(original.buffer);
    const decoded = new Uint8Array(base64_to_array_buffer(b64));
    assert.equal(decoded.length, size);
    let mismatches = 0;
    for (let i = 0; i < size; i++) {
      if (decoded[i] !== original[i]) mismatches++;
    }
    assert.equal(mismatches, 0, `large buffer round-trip had ${mismatches} byte mismatches`);
  });
});

describe('crypto.js — PBKDF2 key derivation', () => {
  it('derive_key_from_password is deterministic for the same password/salt/iterations', async () => {
    const salt = generate_salt();
    const k1 = await derive_key_from_password('same password', salt, TEST_ITERATIONS);
    const k2 = await derive_key_from_password('same password', salt, TEST_ITERATIONS);
    // export both to raw and compare bytes — CryptoKey objects aren't directly comparable.
    const raw1 = new Uint8Array(await crypto.subtle.exportKey('raw', k1));
    const raw2 = new Uint8Array(await crypto.subtle.exportKey('raw', k2));
    assert.equal(raw1.length, raw2.length);
    assert.deepEqual(Array.from(raw1), Array.from(raw2));
  });

  it('different salts for the same password produce keys that cannot decrypt each other\'s ciphertext', async () => {
    const salt_a = generate_salt();
    const salt_b = generate_salt();
    const key_a = await derive_key_from_password('shared password', salt_a, TEST_ITERATIONS);
    const key_b = await derive_key_from_password('shared password', salt_b, TEST_ITERATIONS);

    const encrypted_a = await encrypt('encrypted with key from salt A', key_a);
    const encrypted_b = await encrypt('encrypted with key from salt B', key_b);

    // key_a can read its own ciphertext but not b's, and vice versa.
    assert.equal(await decrypt(encrypted_a, key_a), 'encrypted with key from salt A');

    await assert.rejects(() => decrypt(encrypted_b, key_a), () => true,
      'key from salt A must not decrypt ciphertext from key B (different salt)');
    await assert.rejects(() => decrypt(encrypted_a, key_b), () => true,
      'key from salt B must not decrypt ciphertext from key A (different salt)');
  });

  it('OLD_ITERATIONS and CURRENT_ITERATIONS constants exist', () => {
    assert.equal(OLD_ITERATIONS, 310000);
    assert.equal(CURRENT_ITERATIONS, 600000);
  });
});

describe('crypto.js — salts and IVs are random', () => {
  it('generate_salt returns 16 bytes and is not all-zero', () => {
    const s = generate_salt();
    assert.equal(s.length, 16);
    let nonzero = 0;
    for (const b of s) if (b !== 0) nonzero++;
    assert.ok(nonzero > 0, 'salt should not be all zeros (extremely unlikely for 16 random bytes)');
  });

  it('generate_iv returns 12 bytes and is not all-zero', () => {
    const iv = generate_iv();
    assert.equal(iv.length, 12);
    let nonzero = 0;
    for (const b of iv) if (b !== 0) nonzero++;
    assert.ok(nonzero > 0, 'iv should not be all zeros');
  });

  it('two consecutive salt generations are unlikely to be equal', () => {
    const s1 = generate_salt();
    const s2 = generate_salt();
    let diff = 0;
    for (let i = 0; i < 16; i++) if (s1[i] !== s2[i]) diff++;
    assert.ok(diff > 0, 'two random salts should differ');
  });
});
