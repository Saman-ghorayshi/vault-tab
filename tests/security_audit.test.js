import test from 'node:test';
import assert from 'node:assert/strict';
import { is_unsaveable_url, is_restorable_url, get_url_status } from '../common/urls.js';
import { is_valid_username } from '../common/storage.js';
import { generate_salt, derive_key_from_password, encrypt, decrypt } from '../common/crypto.js';
import { verify_assertion } from '../common/webauthn.js';

test('SECURITY: URL Scheme Injection & Case Sensitivity Bypasses', () => {
  // Case-sensitivity and whitespace bypass vectors
  const malicious_urls = [
    'JAVASCRIPT:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)  ',
    '\n\tjavascript:alert(1)',
    'DATA:text/html,<script>alert(1)</script>',
    'Data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'VBSCRIPT:MsgBox(1)',
    'blob:https://evil.com/uuid-here',
    'BLOB:null/uuid',
    'view-source:https://google.com',
    'filesystem:http://example.com/temporary/myfile.txt',
    'chrome://settings',
    'CHROME://version',
    'chrome-extension://malicious-id/page.html',
    'about:blank',
    'about:config',
    'edge://flags',
    'brave://settings',
    'opera://startpage',
    'vivaldi://history'
  ];

  for (const url of malicious_urls) {
    assert.equal(is_unsaveable_url(url), true, `Expected ${url} to be unsaveable`);
    assert.equal(is_restorable_url(url), false, `Expected ${url} to NOT be restorable`);
    assert.equal(get_url_status(url), 'unsaveable', `Expected get_url_status('${url}') === 'unsaveable'`);
  }

  // Valid web URLs that must be allowed
  const valid_urls = [
    'https://google.com',
    'http://localhost:3000/api',
    'https://sub.domain.co.uk/path/to/resource?param=123#hash',
    'http://127.0.0.1:8080/dashboard'
  ];

  for (const url of valid_urls) {
    assert.equal(is_unsaveable_url(url), false, `Expected ${url} to be saveable`);
    assert.equal(is_restorable_url(url), true, `Expected ${url} to be restorable`);
    assert.equal(get_url_status(url), 'ok', `Expected get_url_status('${url}') === 'ok'`);
  }
});

test('SECURITY: Username Validation & Prototype Pollution Defense', () => {
  // Dangerous / injection identifiers
  const dangerous_usernames = [
    '__proto__',
    'prototype',
    'constructor',
    '',
    ' ',
    'a', // too short (< 2 chars)
    'a'.repeat(33), // too long (> 32 chars)
    'user/admin',
    'user\\admin',
    '../traversal',
    '<script>alert(1)</script>',
    'user\0nullbyte',
    'user name with spaces',
    'admin@email.com',
    'user;DROP TABLE;'
  ];

  for (const u of dangerous_usernames) {
    assert.equal(is_valid_username(u), false, `Expected username '${u}' to be rejected`);
  }

  // Safe valid usernames
  const safe_usernames = [
    'saman',
    'saman-ghorayshi',
    'alice_99',
    'bob.dev',
    'user123'
  ];

  for (const u of safe_usernames) {
    assert.equal(is_valid_username(u), true, `Expected username '${u}' to be accepted`);
  }
});

test('SECURITY: Cryptographic Input Validation & IV Length Enforcement', async () => {
  const salt = generate_salt();
  const key = await derive_key_from_password('password123', salt, 1000);

  // 1. Plaintext must be a string
  await assert.rejects(async () => {
    await encrypt(null, key);
  }, /Invalid plaintext/);

  await assert.rejects(async () => {
    await encrypt(12345, key);
  }, /Invalid plaintext/);

  // 2. Encrypt valid string
  const pkg = await encrypt('Sensitive Research Session Tabs', key);
  assert.ok(pkg.iv);
  assert.ok(pkg.ciphertext);

  // 3. Decrypt with valid package
  const decrypted = await decrypt(pkg, key);
  assert.equal(decrypted, 'Sensitive Research Session Tabs');

  // 4. Decrypt with malformed IV length (e.g. 8 bytes or 16 bytes instead of 12)
  const bad_iv_pkg = {
    iv: btoa('12345678'), // 8 bytes
    ciphertext: pkg.ciphertext
  };
  await assert.rejects(async () => {
    await decrypt(bad_iv_pkg, key);
  }, /Invalid IV length/);

  // 5. Decrypt with corrupted base64 string
  const bad_b64_pkg = {
    iv: '???not-base64???',
    ciphertext: pkg.ciphertext
  };
  await assert.rejects(async () => {
    await decrypt(bad_b64_pkg, key);
  }, /Failed to decode base64/);

  // 6. Decrypt with null/missing object
  await assert.rejects(async () => {
    await decrypt(null, key);
  }, /Invalid encrypted package/);
});

test('SECURITY: WebAuthn User Presence (UP) & RP ID Verification', async () => {
  // Generate an authentic ECDSA keypair for simulation
  const keypair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', keypair.publicKey);

  // Encode a minimal COSE EC2 CBOR map (labels: 1=2(EC2), 3=-7(ES256), -1=1(P-256), -2=x(32b), -3=y(32b))
  function base64url_to_bytes(b64u) {
    const base64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const bin = atob(padded);
    const res = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) res[i] = bin.charCodeAt(i);
    return res;
  }
  const xBytes = base64url_to_bytes(jwk.x);
  const yBytes = base64url_to_bytes(jwk.y);

  // CBOR map with 5 pairs: 0xa5
  const cborKey = new Uint8Array([
    0xa5,
    0x01, 0x02, // 1: 2 (kty: EC2)
    0x03, 0x26, // 3: -7 (alg: ES256)
    0x20, 0x01, // -1: 1 (crv: P-256)
    0x21, 0x58, 0x20, ...xBytes, // -2: x coordinate (32 bytes)
    0x22, 0x58, 0x20, ...yBytes  // -3: y coordinate (32 bytes)
  ]);
  const cborB64u = btoa(String.fromCharCode.apply(null, cborKey))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const challenge = 'test-challenge-12345';
  const origin = 'chrome-extension://testextensionid';
  const rpId = 'testextensionid';

  // 1. Test rejection when authenticatorData is too short (< 37 bytes)
  const shortAuthData = new Uint8Array(20);
  const shortAssertion = {
    client_data_json: btoa(JSON.stringify({ challenge, type: 'webauthn.get', origin }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    authenticator_data: btoa(String.fromCharCode.apply(null, shortAuthData))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    signature: 'AA'
  };
  const shortResult = await verify_assertion(cborB64u, challenge, shortAssertion, origin, rpId);
  assert.equal(shortResult, false, 'Expected rejection when authenticatorData is shorter than 37 bytes');

  // 2. Test rejection when User Present (UP) flag is NOT set (bit 0 of offset 32 is 0)
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  const noUpAuthData = new Uint8Array(37);
  noUpAuthData.set(rpHash, 0); // correct RP ID hash
  noUpAuthData[32] = 0x00; // UP = 0 (No user present!)

  const noUpAssertion = {
    client_data_json: btoa(JSON.stringify({ challenge, type: 'webauthn.get', origin }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    authenticator_data: btoa(String.fromCharCode.apply(null, noUpAuthData))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    signature: 'AA'
  };
  const noUpResult = await verify_assertion(cborB64u, challenge, noUpAssertion, origin, rpId);
  assert.equal(noUpResult, false, 'Expected rejection when User Present (UP) flag is 0');

  // 3. Test rejection when RP ID hash does NOT match expected RP ID
  const wrongRpAuthData = new Uint8Array(37);
  wrongRpAuthData.fill(0xee, 0, 32); // Wrong RP ID hash
  wrongRpAuthData[32] = 0x01; // UP = 1

  const wrongRpAssertion = {
    client_data_json: btoa(JSON.stringify({ challenge, type: 'webauthn.get', origin }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    authenticator_data: btoa(String.fromCharCode.apply(null, wrongRpAuthData))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    signature: 'AA'
  };
  const wrongRpResult = await verify_assertion(cborB64u, challenge, wrongRpAssertion, origin, rpId);
  assert.equal(wrongRpResult, false, 'Expected rejection when RP ID hash does not match');
});
