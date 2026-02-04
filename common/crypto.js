/**
 * Cryptographic functions for Aegis Tab
 */

// Convert ArrayBuffer to Base64
export function arrayBufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

// Convert Base64 to ArrayBuffer
export function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Generate a random 16-byte salt
export async function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// Generate a random 12-byte IV
export async function generateIv() {
  return crypto.getRandomValues(new Uint8Array(12));
}

// Derive a key from password using PBKDF2
export async function deriveKeyFromPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
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
      iterations: 310000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true, // Changed to true to allow the key to be extractable
    ['encrypt', 'decrypt']
  );
}

// Encrypt plaintext using AES-GCM
export async function encrypt(plaintext, key) {
  const encoder = new TextEncoder();
  const iv = await generateIv();
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    encoder.encode(plaintext)
  );
  
  return {
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(encrypted)
  };
}

export async function exportKey(key) {
  return crypto.subtle.exportKey(
    "raw",
    key
  );
}

export async function importKey(keyBuffer) {
  return crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "AES-GCM", length: 256 },
    true, // extractable
    ["encrypt", "decrypt"]
  );
}



// Decrypt ciphertext using AES-GCM
export async function decrypt(encryptedPackage, key) {
  try {
    const decoder = new TextDecoder();
    const iv = base64ToArrayBuffer(encryptedPackage.iv);
    const ciphertext = base64ToArrayBuffer(encryptedPackage.ciphertext);
    
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      key,
      ciphertext
    );
    
    return decoder.decode(decrypted);
  } catch (error) {
    throw new Error('Decryption failed');
  }
}

