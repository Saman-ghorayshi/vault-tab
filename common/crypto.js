// Cryptographic functions for Aegis Tab
// Uses Web Crypto API with AES-256-GCM for authenticated encryption

// convert ArrayBuffer to Base64 without spreading (avoids stack overflow on large buffers)
export function array_buffer_to_base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk_size = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk_size) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk_size));
  }
  return btoa(binary);
}

// convert Base64 string back to ArrayBuffer
export function base64_to_array_buffer(base64) {
  const binary_string = atob(base64);
  const bytes = new Uint8Array(binary_string.length);
  for (let i = 0; i < binary_string.length; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

// generate a random 16-byte salt for key derivation
export function generate_salt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// generate a random 12-byte IV for AES-GCM
export function generate_iv() {
  return crypto.getRandomValues(new Uint8Array(12));
}

// iteration counts for PBKDF2-HMAC-SHA256
// old accounts were created at 310000; we now use 600000 per current OWASP guidance.
// existing accounts are transparently upgraded on the next successful unlock.
export const OLD_ITERATIONS = 310000;
export const CURRENT_ITERATIONS = 600000;

// derive an AES-GCM key from a password using PBKDF2
// iterations must be passed by the caller — the function no longer hardcodes it.
export async function derive_key_from_password(password, salt, iterations) {
  // if iterations is not provided, fall back to the old default so existing
  // call sites that haven't been updated yet don't break
  const iter = iterations || OLD_ITERATIONS;
  const encoder = new TextEncoder();
  const key_material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iter,
      hash: 'SHA-256'
    },
    key_material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// encrypt plaintext string with AES-GCM, returns { iv, ciphertext } as base64
export async function encrypt(plaintext, key) {
  const encoder = new TextEncoder();
  const iv = generate_iv();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoder.encode(plaintext)
  );

  return {
    iv: array_buffer_to_base64(iv),
    ciphertext: array_buffer_to_base64(encrypted)
  };
}

// decrypt a package with AES-GCM, returns plaintext string
export async function decrypt(encrypted_package, key) {
  const decoder = new TextDecoder();
  const iv = base64_to_array_buffer(encrypted_package.iv);
  const ciphertext = base64_to_array_buffer(encrypted_package.ciphertext);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    return decoder.decode(decrypted);
  } catch (err) {
    throw err;
  }
}

// export a CryptoKey to raw ArrayBuffer for storage
export async function export_key(key) {
  return crypto.subtle.exportKey('raw', key);
}

// import a raw ArrayBuffer back into a CryptoKey
export async function import_key(key_buffer) {
  return crypto.subtle.importKey(
    'raw',
    key_buffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}
