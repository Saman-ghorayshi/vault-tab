// end-to-end test of webauthn.js — proves the COSE/CBOR parser fixes work.
//
// We can't call navigator.credentials in Node. But webauthn.js exports
// serialize_credential (uses parse_attestation_object) and verify_assertion
// (uses parse_cose_ec2_key). intermediate escaping problem: serialize_credential
// takes a navigator.credentials.create() result, which we don't have here.
//
// So we do two things:
//   1) Hand-construct an attestation object (the exact bytes a real
//      authenticator produces) and call serialize_credential on it via a
//      synthetic credential object. This proves parse_attestation_object
//      reads credential_id and public_key_cbor from the right buffer.
//   2) Then immediately call verify_assertion against the parsed public key,
//      using a signature we compute with Web Crypto from a key we control.
//      This proves parse_cose_ec2_key returns a usable CryptoKey (i.e.
//      returns real x and y, not an empty map that throws).
//
// If the legacy buggy versions were in place: step 1 would yield a wrong
// public_key_cbor (read from the wrong buffer) and step 2 would always throw
// "COSE key missing x/y coordinates" then return false.

// Node 24+: globalThis.crypto IS webcrypto already, no need to assign it.
globalThis.chrome = { runtime: { id: 'test-extension-id' } };

import { readFileSync } from 'node:fs';
// webauthn.js uses `export` so load it as a module via data URL.
const src = readFileSync(new URL('./common/webauthn.js', import.meta.url), 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
const webauthn = await import(dataUrl);

// --- step 1: build an ECDSA P-256 key pair with Web Crypto (our test key) ---
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true, ['sign', 'verify']
);
const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

// helper: base64url-decode a JWK field into a Uint8Array
function b64url_to_u8(s) {
  const b = Buffer.from(s, 'base64');
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b[i];
  return u;
}
const xBytes = b64url_to_u8(jwk.x);
const yBytes = b64url_to_u8(jwk.y);

// sanity: P-256 coordinates are exactly 32 bytes
if (xBytes.length !== 32 || yBytes.length !== 32) {
  console.error('PRECONDITION FAIL: jwk x/y not 32 bytes');
  process.exit(2);
}

// --- step 2: build the COSE-EC2 public key as CBOR ---
// {1:2, 3:-7, -1:1, -2:x, -3:y}  (kty=EC2, alg=ES256, crv=P-256)
const coseKey = new Uint8Array([
  0xa5,                              // map(5)
  0x01, 0x02,                        // 1: 2 (kty=EC2)
  0x03, 0x26,                        // 3: -7 (alg=ES256; 0x26 → -(6+1)=-7)
  0x20, 0x01,                        // -1: 1 (crv=P-256)
  0x21, 0x58, 0x20, ...xBytes,       // -2: bstr(32) x
  0x22, 0x58, 0x20, ...yBytes,       // -3: bstr(32) y
]);

// --- step 3: build a WebAuthn authData containing attested credential data ---
// rpIdHash(32) | flags(1) | signCount(4) | aaguid(16) | credIdLen(2) | credId | cosePubKey
const rpIdHash = new Uint8Array(32);  // not verified by the assertion path
const flags = new Uint8Array([0x41]); // bit 6 (AT) set, bit 0 (UP) set
const signCount = new Uint8Array(4);  // 0
const aaguid = new Uint8Array(16);    // all-zero
const credId = new Uint8Array(16);
for (let i = 0; i < 16; i++) credId[i] = i + 1;
const credIdLen = new Uint8Array([0x00, 0x10]); // 16 big-endian
const authDataInner = concat([rpIdHash, flags, signCount, aaguid, credIdLen, credId, coseKey]);

// --- step 4: wrap authData in a minimal CBOR attestation object ---
// {"fmt": "none", "attStmt": {}, "authData": <bytes>}
const attestation = cborMap({
  'fmt': cborText('none'),
  'attStmt': new Uint8Array([0xa0]),     // empty map
  'authData': cborBstr(authDataInner),
});

// --- step 5: run serialize_credential on a synthetic credential object ---
// serialize_credential reads credential.response.attestationObject
const credential = {
  response: { attestationObject: attestation.buffer }
};
let serialized;
try {
  serialized = webauthn.serialize_credential(credential);
} catch (e) {
  console.error('FAIL: serialize_credential threw:', e.message);
  process.exit(1);
}

// the parsed credential_id must equal the one we embedded
const parsedCredId = Buffer.from(serialized.credential_id, 'base64').toString('hex');
const expectedCredId = Buffer.from(credId).toString('hex');
if (parsedCredId !== expectedCredId) {
  console.error('FAIL: credential_id mismatch');
  console.error('  parsed =', parsedCredId);
  console.error('  expect =', expectedCredId);
  process.exit(1);
}

// round-trip the parsed public_key_cbor: parse_cose_ec2_key should give back
// exactly x and y. We import it as a CryptoKey and compare SPDI with the
// signing key's public half — if it imports and verifies a real signature,
// the COSE key was read correctly.
const pubCbor = new Uint8Array(Buffer.from(serialized.public_key_cbor, 'base64'));
console.error('parsed pubCbor length =', pubCbor.length, 'first bytes =', Array.from(pubCbor.slice(0,6)));
console.error('embedded coseKey length =', coseKey.length, 'first bytes =', Array.from(coseKey.slice(0,6)));
// the parsed COSE key should be byte-for-byte identical to what we embedded.
if (pubCbor.length !== coseKey.length) {
  console.error('WARN: length mismatch — wrong offset');
} else {
  for (let i = 0; i < pubCbor.length; i++) {
    if (pubCbor[i] !== coseKey[i]) { console.error(`WARN: pubCbor[${i}] = ${pubCbor[i]} expect ${coseKey[i]}`); break; }
  }
}

// step 6: build clientDataJSON for a get() assertion with our challenge
const challengeRaw = new Uint8Array(32);
crypto.getRandomValues(challengeRaw);
const challengeB64 = webauthn.generate_challenge(); // we use this same one
const origin = `chrome-extension://${chrome.runtime.id}`;
const clientData = JSON.stringify({
  type: 'webauthn.get',
  challenge: challengeB64,
  origin: origin,
});
const clientDataBytes = new TextEncoder().encode(clientData);

// step 7: build authenticatorData for the assertion (no attested cred data
// here, just rpIdHash + flags + signCount). Verified path doesn't check rpId.
const authDataAssertion = concat([rpIdHash, new Uint8Array([0x01]), signCount]);

// step 8: sign (authDataAssertion || SHA256(clientDataJSON)) with private key
const signedData = concat([authDataAssertion, new Uint8Array(
  await crypto.subtle.digest('SHA-256', clientDataBytes)
)]);
const signature = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  keyPair.privateKey,
  signedData
);

// step 9: assemble a serialized assertion exactly like serialize_assertion
// would, and call verify_assertion — the real registration→unlock path.
const assert = {
  credential_id: serialized.credential_id,
  client_data_json: b64url(clientDataBytes),
  authenticator_data: b64url(authDataAssertion),
  signature: b64url(new Uint8Array(signature)),
};

// isolation: verify the signature directly with our own public key, bypassing
// webauthn's parser. If THIS passes, the math/encoding is right and any
// failure inside verify_assertion must be a parse/origin issue.
{
  const sigBytes = new Uint8Array(Buffer.from(assert.signature, 'base64'));
  const adBytes = new Uint8Array(Buffer.from(assert.authenticator_data, 'base64'));
  const cdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
  const sd = concat([adBytes, cdHash]);
  const vOwn = await crypto.subtle.verify({name:'ECDSA', hash:'SHA-256'}, keyPair.publicKey, sigBytes, sd);
  console.error('isolation: verify with own pubkey =', vOwn, ' sigLen=', sigBytes.length, ' sdLen=', sd.length);
}

let valid;
let diag = '';
try {
  // temporarily monkeypatch to capture the rejection reason — verify_assertion
  // swallows all errors and returns false, so we want to see which check fails.
  const clientDataRaw = Buffer.from(assert.client_data_json, 'base64');
  const clientDataStr = new TextDecoder().decode(clientDataRaw);
  const cd = JSON.parse(clientDataStr);
  diag += `clientData type=${cd.type} challenge=${cd.challenge === challengeB64 ? 'MATCH' : 'MISMATCH'} origin=${cd.origin === origin ? 'MATCH' : 'MISMATCH'}\n`;
  diag += `challenge_b64=${challengeB64.slice(0,16)}... cd_chal=${cd.challenge?.slice(0,16)}...\n`;
  valid = await webauthn.verify_assertion(
    serialized.public_key_cbor,
    challengeB64,
    assert,
    origin
  );
} catch (e) {
  console.error('FAIL: verify_assertion threw:', e.message);
  process.exit(1);
}
console.error(diag);

if (valid !== true) {
  console.error('FAIL: verify_assertion returned', valid, '(expected true)');
  process.exit(1);
}

// also check the negative case: tampered challenge must fail
const badAssert = { ...assert, client_data_json: b64url(
  new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: 'wrong',
    origin })) ) };
let badValid;
try {
  badValid = await webauthn.verify_assertion(
    serialized.public_key_cbor, challengeB64, badAssert, origin);
} catch (_) { badValid = false; }
if (badValid === true) {
  console.error('FAIL: tampered challenge was accepted');
  process.exit(1);
}

console.log('PASS: registration parse + assertion verify + tamper reject all OK');
process.exit(0);

// ---- helpers ----
function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function cborText(s) {
  const enc = new TextEncoder().encode(s);
  const head = enc.length < 24
    ? new Uint8Array([0x60 | enc.length])
    : new Uint8Array([0x78, enc.length]);
  return concat([head, enc]);
}
function cborBstr(b) {
  const head = b.length < 24
    ? new Uint8Array([0x40 | b.length])
    : b.length < 256
      ? new Uint8Array([0x58, b.length])
      : new Uint8Array([0x59, (b.length >> 8) & 0xff, b.length & 0xff]);
  return concat([head, b]);
}
function cborMap(obj) {
  const entries = Object.entries(obj);
  const head = new Uint8Array([0xa0 | entries.length]);
  // each entry is a CBOR text-string key followed by the value bytes.
  return concat([head, ...entries.flatMap(([k, v]) => [cborText(k), v])]);
}
