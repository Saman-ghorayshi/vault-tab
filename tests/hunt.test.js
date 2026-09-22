import test from 'node:test';
import assert from 'node:assert';
import { generate_salt, derive_key_from_password, encrypt, decrypt } from '../common/crypto.js';

test('VULNERABILITY HUNT: Malformed Backup Import (Data Validation)', () => {
  // Simulating the exact logic from manager.js process_backup_import
  const backup_data = {
    format: 'vaulttab-backup',
    groups: [
      { id: 'valid-group-1', iv: 'abc', ciphertext: 'def' },
      null, // What if a group is null?
      { title: 'hacked-no-id' }, // What if it has no ID?
      'just-a-string' // What if it's not an object?
    ]
  };

  const existing_groups = [{ id: 'valid-group-1' }];
  const existing_ids = new Set(existing_groups.map(g => g.id));
  
  // The loop currently in manager.js:
  let crashed = false;
  try {
    for (const group of backup_data.groups) {
      if (!existing_ids.has(group.id)) { // <-- WILL CRASH ON NULL/STRING
        existing_groups.unshift(group);
      }
    }
  } catch (err) {
    crashed = true;
  }
  
  // Our hunt expects to find a crash here, exposing a lack of validation
  assert.strictEqual(crashed, true, 'Backup import is vulnerable to missing object properties and crashes!');
});

test('VULNERABILITY HUNT: Ciphertext Tampering & Bit Flipping', async () => {
  const password = 'super_secret_password';
  const salt = generate_salt();
  const key = await derive_key_from_password(password, salt, 1000); // 1000 for faster test
  
  const original_data = '{"tabs": [{"url": "https://google.com"}]}';
  const encrypted_group = await encrypt(original_data, key);
  
  // Let's modify exactly 1 character of the ciphertext base64 string
  // This simulates data corruption on disk or network transit.
  const modified_ciphertext = encrypted_group.ciphertext.substring(0, encrypted_group.ciphertext.length - 2) + (encrypted_group.ciphertext.endsWith('A') ? 'B' : 'A') + '=';
  
  const corrupted_group = {
    id: encrypted_group.id,
    iv: encrypted_group.iv,
    ciphertext: modified_ciphertext
  };

  let decryption_failed = false;
  try {
    await decrypt(corrupted_group, key);
  } catch (err) {
    decryption_failed = true;
    // AES-GCM should throw an authentication tag mismatch
  }
  
  assert.strictEqual(decryption_failed, true, 'AES-GCM failed to catch ciphertext tampering!');
});
