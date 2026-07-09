// WebAuthn utilities for Aegis Tab — second-factor authentication
// uses the WebAuthn API (navigator.credentials) in extension pages and
// verifies assertions via the Web Crypto API in the service worker.

// minimal CBOR parser — extracts COSE EC2 public key components
// returns { x: Uint8Array, y: Uint8Array } for P-256 keys.
//
// A COSE EC2 key is a CBOR map (major type 5) whose keys are CBOR *integers*
// (label 1 = kty, label 3 = alg, -1 = crv, -2 = x, -3 = y) — never text
// strings. The values for x and y are byte strings (32 bytes each for P-256).
// Reading these correctly is what makes passkey verification work.
function parse_cose_ec2_key(cbor_bytes) {
  const dv = new DataView(cbor_bytes.buffer, cbor_bytes.byteOffset, cbor_bytes.byteLength);
  const offset = { value: 0 };

  // initial byte: major type 5 (map), short-form item count in the low 5 bits.
  // 0xaN means "map with N pairs". extra-length forms (0xbb, etc.) don't
  // show up for COSE keys but we read the count generally just in case.
  const head = dv.getUint8(offset.value);
  offset.value++;
  if ((head >> 5) !== 5) throw new Error('Expected CBOR map');
  const num_pairs = read_cbor_item_length(head, dv, offset);

  const map = {};
  for (let i = 0; i < num_pairs; i++) {
    if (offset.value >= cbor_bytes.length) break;

    // key: CBOR integer (major type 0 unsigned or major type 1 negative).
    // COSE labels like -2 and -3 are negative ints, encoded as -(n+1).
    const key_label = read_cbor_int(cbor_bytes, dv, offset);
    if (key_label === null) break;

    // value: for kty/crv/alg it's an integer; for x/y it's a byte string.
    const val_byte = dv.getUint8(offset.value);
    const val_mt = val_byte >> 5;

    if (val_mt === 2) {
      // byte string — x coordinate (label -2) or y coordinate (label -3).
      // 32-byte values use the one-byte length form (0x58 0x20), so go
      // through read_cbor_item_length instead of the low 5 bits.
      offset.value++; // skip the major-type byte
      const len_off = { value: offset.value };
      const len = read_cbor_item_length(val_byte, dv, len_off);
      offset.value = len_off.value;
      map[key_label] = new Uint8Array(cbor_bytes.slice(offset.value, offset.value + len));
      offset.value += len;
    } else if (val_mt === 0 || val_mt === 1) {
      // unsigned or negative integer (kty, crv, alg)
      map[key_label] = read_cbor_int(cbor_bytes, dv, offset);
    } else {
      // unexpected value type — skip it so we don't desync the stream
      skip_cbor_item(cbor_bytes, dv, offset);
    }
  }

  if (!map[-2] || !map[-3]) {
    throw new Error('COSE key missing x/y coordinates');
  }
  return { x: map[-2], y: map[-3] };
}

// read a CBOR integer (unsigned major type 0 or negative major type 1) and
// advance offset.value. CBOR negative encoding is value = -(n) - 1, so
// 0x20 is -1, 0x21 is -2, 0x22 is -3, etc. returns null on non-integer.
function read_cbor_int(bytes, dv, offset_obj) {
  const byte = dv.getUint8(offset_obj.value);
  const mt = byte >> 5;
  const additional = byte & 0x1f;
  offset_obj.value++;

  if (mt !== 0 && mt !== 1) return null;

  let value;
  if (additional < 24) {
    value = additional;
  } else {
    const num_bytes = additional - 23; // 24→1, 25→2, 26→4, 27→8
    value = 0;
    for (let i = 0; i < num_bytes; i++) {
      value = (value << 8) | dv.getUint8(offset_obj.value);
      offset_obj.value++;
    }
  }
  return mt === 1 ? -(value) - 1 : value;
}

// import a COSE EC2 public key as a CryptoKey usable for ECDSA verification.
async function cose_key_to_cryptokey(cbor_bytes) {
  const { x, y } = parse_cose_ec2_key(cbor_bytes);

  // build the raw SPKI-like JWK for P-256
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: uint8array_to_base64url(x),
    y: uint8array_to_base64url(y),
  };

  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

// base64url (no padding) helpers
function uint8array_to_base64url(arr) {
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64url_to_array_buffer(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(base64 + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// generate a random 32-byte challenge, base64url-encoded
export function generate_challenge() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return uint8array_to_base64url(bytes);
}

// build the PublicKeyCredentialCreationOptions for registering a passkey.
// rp_name is shown to the user (e.g. "Aegis Tab").
export function make_registration_options(challenge_b64, rp_name = 'Aegis Tab') {
  const challenge = base64url_to_array_buffer(challenge_b64);
  const rp_id = chrome.runtime.id;
  const user_id = crypto.getRandomValues(new Uint8Array(16));

  return {
    challenge,
    rp: { name: rp_name, id: rp_id },
    user: {
      id: user_id,
      name: rp_id,
      displayName: rp_name
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 only
    authenticatorSelection: {
      userVerification: 'required',
    },
    attestation: 'none',
    timeout: 60000
  };
}

// extract the credential ID and COSE-encoded public key from a
// registration response (navigator.credentials.create() result).
// returns { credential_id (base64url), public_key_cbor (base64url) }
export function serialize_credential(credential) {
  const att_obj_bytes = new Uint8Array(credential.response.attestationObject);
  return parse_attestation_object(att_obj_bytes);
}

// read the CBOR item length from the initial byte and advance offset.
// returns the item length (for strings/arrays/maps).
// supports short form (0-23) and extra-length bytes (24-27).
function read_cbor_item_length(byte, dv, offset_obj) {
  const mt = byte >> 5;
  const additional = byte & 0x1f;
  if (additional < 24) {
    return additional;
  }
  const num_bytes = additional - 23; // 24→1, 25→2, 26→4, 27→8
  let value = 0;
  for (let i = 0; i < num_bytes; i++) {
    value = (value << 8) | dv.getUint8(offset_obj.value);
    offset_obj.value++;
  }
  return value;
}

// skip one CBOR item (recursively for containers), advancing the offset.
function skip_cbor_item(bytes, dv, offset_obj) {
  if (offset_obj.value >= bytes.length) return;
  const byte = dv.getUint8(offset_obj.value);
  const mt = byte >> 5;
  const additional = byte & 0x1f;
  offset_obj.value++;

  // additional length bytes for the header
  let header_length_bytes = 0;
  if (additional >= 24 && additional <= 27) {
    header_length_bytes = additional - 23;
    offset_obj.value += header_length_bytes;
  }

  if (mt === 0 || mt === 1 || mt === 7) {
    // integer (unsigned or negative) or simple/float — no body
    return;
  }

  // read the actual item length from the CBOR header
  // rewind to read it properly
  const saved_pos = offset_obj.value - 1 - header_length_bytes;
  const item_byte = dv.getUint8(saved_pos);
  offset_obj.value = saved_pos + 1; // reset to just past the mt byte

  // rebuild offset for read_cbor_item_length
  const len_offset = { value: saved_pos + 1 };
  let item_length;
  if (additional < 24) {
    item_length = additional;
  } else {
    // skip the header length bytes we already consumed
    for (let i = 0; i < header_length_bytes; i++) {
      dv.getUint8(len_offset.value);
      len_offset.value++;
    }
    item_length = read_cbor_item_length(item_byte, dv, len_offset);
    offset_obj.value = len_offset.value;
  }

  if (mt === 2 || mt === 3) {
    // byte string or text string — skip content
    offset_obj.value += item_length;
  } else if (mt === 4) {
    // array — skip each element
    for (let i = 0; i < item_length && offset_obj.value < bytes.length; i++) {
      skip_cbor_item(bytes, dv, offset_obj);
    }
  } else if (mt === 5) {
    // map — skip each key+value pair
    for (let i = 0; i < item_length && offset_obj.value < bytes.length; i++) {
      skip_cbor_item(bytes, dv, offset_obj); // key
      skip_cbor_item(bytes, dv, offset_obj); // value
    }
  }
  // mt=6 (tag) and others are rare in attestation objects — skip
}

function parse_attestation_object(att_obj_bytes) {
  const dv = new DataView(att_obj_bytes.buffer, att_obj_bytes.byteOffset, att_obj_bytes.byteLength);
  const offset = { value: 0 };

  // outer CBOR map
  if ((dv.getUint8(offset.value) >> 5) !== 5) throw new Error('Expected CBOR map');
  offset.value++;

  // walk key-value pairs to find authData
  let auth_data_bytes = null;

  while (offset.value < att_obj_bytes.length) {
    const key_byte = dv.getUint8(offset.value);
    const key_mt = key_byte >> 5;

    // check for break byte (0xff) in indefinite-length maps
    if (key_byte === 0xff) break;

    // save position of the key content
    const key_offset = { value: offset.value + 1 };
    offset.value++;

    // parse key
    let key_text = null;
    if (key_mt === 3) {
      // text string key — read the key text
      const key_len_offset = { value: offset.value };
      const key_len = read_cbor_item_length(key_byte, dv, key_len_offset);
      offset.value = key_len_offset.value;
      const decoder = new TextDecoder();
      key_text = decoder.decode(att_obj_bytes.slice(offset.value, offset.value + key_len));
      offset.value += key_len;
    } else if (key_mt === 0 || key_mt === 1) {
      // integer key — skip the value (additional bytes already consumed)
      // used for COSE map keys
    } else {
      break;
    }

    // now parse the value
    if (offset.value >= att_obj_bytes.length) break;

    // If key is 'authData', capture the value specifically
    if (key_text === 'authData') {
      const val_byte = dv.getUint8(offset.value);
      const val_mt = val_byte >> 5;
      if (val_mt === 2) { // byte string
        offset.value++; // skip mt byte
        const len_offset = { value: offset.value };
        const val_len = read_cbor_item_length(val_byte, dv, len_offset);
        offset.value = len_offset.value;
        auth_data_bytes = att_obj_bytes.slice(offset.value, offset.value + val_len);
        offset.value += val_len;
      } else {
        break;
      }
    } else {
      // skip any other value
      skip_cbor_item(att_obj_bytes, dv, offset);
    }
  }

  if (!auth_data_bytes || auth_data_bytes.length < 37) {
    // fallback: find the fakeUserPublicKey in attStmt instead?
    // no — the spec says authData is the authoritative source
    throw new Error('Could not find authData in attestation object');
  }

  // parse authData
  // [rpIdHash (32)][flags (1)][signCount (4)][attestedCredentialData?]
  const auth_dv = new DataView(auth_data_bytes.buffer, auth_data_bytes.byteOffset, auth_data_bytes.byteLength);
  const flags = auth_dv.getUint8(32);
  const has_attested = (flags & 0x40) !== 0;

  if (!has_attested) {
    throw new Error('No attested credential data in authData');
  }

  let ad_offset = 37; // skip rpIdHash (32) + flags (1) + signCount (4)

  // skip AAGUID (16 bytes)
  ad_offset += 16;

  // read credential ID length (2 bytes, big-endian)
  const cred_id_len = (auth_dv.getUint8(ad_offset) << 8) | auth_dv.getUint8(ad_offset + 1);
  ad_offset += 2;

  // read credential ID — offsets here are relative to auth_data_bytes,
  // which is the authData sub-slice above. (Buggy version read from
  // att_obj_bytes with authData-relative offsets, which slices the wrong
  // bytes — producing a credential ID and public key that don't match
  // what the authenticator actually made. Everything downstream of that
  // is broken from registration onward.)
  const cred_id = auth_data_bytes.slice(ad_offset, ad_offset + cred_id_len);
  ad_offset += cred_id_len;

  // the rest of authData is the COSE-encoded public key
  const public_key_cbor = auth_data_bytes.slice(ad_offset);

  return {
    credential_id: uint8array_to_base64url(new Uint8Array(cred_id)),
    public_key_cbor: uint8array_to_base64url(new Uint8Array(public_key_cbor))
  };
}

// build the PublicKeyCredentialRequestOptions for asserting a passkey.
export function make_assertion_options(challenge_b64, credential_id_b64) {
  const challenge = base64url_to_array_buffer(challenge_b64);
  const rp_id = chrome.runtime.id;
  const credential_id = base64url_to_array_buffer(credential_id_b64);

  return {
    challenge,
    rpId: rp_id,
    allowCredentials: [{
      type: 'public-key',
      id: credential_id,
      transports: ['internal', 'usb', 'nfc', 'ble']
    }],
    userVerification: 'required',
    timeout: 60000
  };
}

// extract the credential ID, clientDataJSON, authenticatorData, and signature
// from a successful navigator.credentials.get() result.
// returns { credential_id, client_data_json, authenticator_data, signature }
// all values are base64url-encoded strings for passing via messages.
export function serialize_assertion(assertion) {
  return {
    credential_id: uint8array_to_base64url(new Uint8Array(assertion.rawId)),
    client_data_json: uint8array_to_base64url(
      new Uint8Array(assertion.response.clientDataJSON)
    ),
    authenticator_data: uint8array_to_base64url(
      new Uint8Array(assertion.response.authenticatorData)
    ),
    signature: uint8array_to_base64url(
      new Uint8Array(assertion.response.signature)
    )
  };
}

// verify a WebAuthn assertion in the service worker.
// credential_public_key_cbor: the CBOR-encoded COSE key stored during registration
//   (base64url-encoded string, as returned by serialize_credential).
// challenge_b64: the original challenge sent to the client.
// assertion: the serialized assertion from serialize_assertion().
// origin: the extension's origin (chrome-extension://<id>).
// returns true if the signature is valid.
export async function verify_assertion(
  credential_public_key_cbor,
  challenge_b64,
  assertion,
  origin
) {
  try {
    // 0. decode the COSE key from base64url to a Uint8Array — the parser
    //    expects raw bytes, but we receive the serialized string from storage.
    const cose_key_bytes = new Uint8Array(
      base64url_to_array_buffer(credential_public_key_cbor)
    );
    // 1. parse clientDataJSON
    const client_data_raw = base64url_to_array_buffer(assertion.client_data_json);
    const decoder = new TextDecoder();
    const client_data_str = decoder.decode(client_data_raw);
    const client_data = JSON.parse(client_data_str);

    // verify the challenge matches
    if (client_data.challenge !== challenge_b64) {
      return false;
    }
    // verify the type is "webauthn.get"
    if (client_data.type !== 'webauthn.get') {
      return false;
    }
    // verify the origin matches
    if (client_data.origin !== origin) {
      return false;
    }

    // 2. build the signature payload:
    //    authenticatorData + SHA256(clientDataJSON)
    const auth_data = base64url_to_array_buffer(assertion.authenticator_data);
    const client_data_hash = await crypto.subtle.digest('SHA-256', client_data_raw);
    const signed_data = new Uint8Array(auth_data.byteLength + client_data_hash.byteLength);
    signed_data.set(new Uint8Array(auth_data), 0);
    signed_data.set(new Uint8Array(client_data_hash), auth_data.byteLength);

    // 3. parse the COSE public key and verify
    const public_key = await cose_key_to_cryptokey(cose_key_bytes);
    const signature = base64url_to_array_buffer(assertion.signature);

    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      public_key,
      signature,
      signed_data
    );
  } catch (_) {
    return false;
  }
}
