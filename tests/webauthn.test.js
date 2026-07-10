import test from 'node:test';
import assert from 'node:assert/strict';
import {
  der_to_raw_ecdsa_signature
} from '../common/webauthn.js';

test('der_to_raw_ecdsa_signature converts ASN.1 DER ECDSA signature to 64-byte IEEE P1363 raw signature', () => {
  // Construct a synthetic DER signature with 33-byte r (0x00 padded) and 32-byte s
  const rPadded = new Uint8Array(33);
  rPadded[0] = 0x00;
  rPadded.fill(0x11, 1); // 32 bytes of 0x11

  const s = new Uint8Array(32);
  s.fill(0x22); // 32 bytes of 0x22

  const der = new Uint8Array([
    0x30, 0x45, // SEQUENCE, length 69
    0x02, 0x21, ...rPadded, // INTEGER r, length 33
    0x02, 0x20, ...s // INTEGER s, length 32
  ]);

  const raw = new Uint8Array(der_to_raw_ecdsa_signature(der.buffer));
  assert.equal(raw.byteLength, 64);
  assert.deepEqual(raw.slice(0, 32), new Uint8Array(32).fill(0x11));
  assert.deepEqual(raw.slice(32, 64), new Uint8Array(32).fill(0x22));
});

test('der_to_raw_ecdsa_signature leaves already-raw 64-byte P1363 signature unchanged', () => {
  const rawSig = new Uint8Array(64).fill(0x42).buffer;
  const result = der_to_raw_ecdsa_signature(rawSig);
  assert.equal(result, rawSig);
});
