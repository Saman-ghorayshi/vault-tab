import test from 'node:test';
import assert from 'node:assert/strict';

// Mock chrome.storage.local before importing storage.js
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const res = {};
          keys.forEach(k => res[k] = store[k]);
          return res;
        }
        if (keys && typeof keys === 'object') {
          const res = {};
          for (const k in keys) res[k] = store[k] !== undefined ? store[k] : keys[k];
          return res;
        }
        return { ...store };
      },
      set: async (items) => {
        Object.assign(store, items);
      },
      remove: async (key) => {
        delete store[key];
      }
    }
  }
};

const { purge_expired_or_burner_groups, delete_tab_group_by_id, save_user, get_tab_groups, save_tab_groups } = await import('../common/storage.js');

const TEST_USER = 'burner_test_user';

test('BURNER: TTL Expiration and Panic Purge Logic', async () => {
  // Create user
  await save_user({
    username: TEST_USER,
    password_salt: 'dummy_salt',
    password_verifier: { iv: 'iv', ciphertext: 'ct' },
    tab_groups: []
  });

  const now = Date.now();
  const mock_groups = [
    { id: 'normal-1', iv: 'iv1', ciphertext: 'c1', is_burner: false },
    { id: 'expired-burner', iv: 'iv2', ciphertext: 'c2', is_burner: true, expires_at: now - 5000 },
    { id: 'active-burner', iv: 'iv3', ciphertext: 'c3', is_burner: true, burn_on_restore: true, expires_at: now + 3600000 },
    { id: 'normal-2', iv: 'iv4', ciphertext: 'c4', is_burner: false }
  ];

  await save_tab_groups(TEST_USER, mock_groups);

  // 1. Periodic sweep (purge_all_burners = false): should only purge expired-burner
  const purged_periodic = await purge_expired_or_burner_groups(TEST_USER, false);
  assert.equal(purged_periodic, 1, 'Expected exactly 1 expired group to be purged');

  let current_groups = await get_tab_groups(TEST_USER);
  assert.equal(current_groups.length, 3);
  assert.ok(!current_groups.find(g => g.id === 'expired-burner'));
  assert.ok(current_groups.find(g => g.id === 'active-burner'));
  assert.ok(current_groups.find(g => g.id === 'normal-1'));

  // 2. Panic wipe (purge_all_burners = true): should purge active-burner immediately
  const purged_panic = await purge_expired_or_burner_groups(TEST_USER, true);
  assert.equal(purged_panic, 1, 'Expected active burner to be purged during panic wipe');

  current_groups = await get_tab_groups(TEST_USER);
  assert.equal(current_groups.length, 2, 'Expected only 2 normal groups to remain');
  assert.ok(current_groups.find(g => g.id === 'normal-1'));
  assert.ok(current_groups.find(g => g.id === 'normal-2'));
});

test('BURNER: Delete single group by ID (Burn on restore simulation)', async () => {
  const mock_groups = [
    { id: 'keep-1', iv: 'iv1', ciphertext: 'c1' },
    { id: 'burn-me', iv: 'iv2', ciphertext: 'c2', is_burner: true, burn_on_restore: true }
  ];

  await save_tab_groups(TEST_USER, mock_groups);

  const deleted = await delete_tab_group_by_id(TEST_USER, 'burn-me');
  assert.equal(deleted, true);

  const remaining = await get_tab_groups(TEST_USER);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'keep-1');

  // Deleting nonexistent id
  const deleted_nonexistent = await delete_tab_group_by_id(TEST_USER, 'nonexistent');
  assert.equal(deleted_nonexistent, false);
});
