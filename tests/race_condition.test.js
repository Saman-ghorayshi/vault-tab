import test from 'node:test';
import assert from 'node:assert';
import { AsyncMutex } from '../common/mutex.js';

// Simulate Chrome Storage Local with artificial async delays
const mockStorage = {
  data: {},
  async get(key) {
    return new Promise(resolve => {
      setTimeout(() => {
        const val = this.data[key] ? JSON.parse(JSON.stringify(this.data[key])) : undefined;
        resolve({ [key]: val });
      }, 5);
    });
  },
  async set(obj) {
    return new Promise(resolve => {
      setTimeout(() => {
        Object.assign(this.data, obj);
        resolve();
      }, 5); // 5ms delay to write
    });
  }
};

async function get_tab_groups(username) {
  const result = await mockStorage.get(`vaulttab_groups_${username}`);
  return result[`vaulttab_groups_${username}`] || [];
}

async function save_tab_groups(username, groups) {
  await mockStorage.set({ [`vaulttab_groups_${username}`]: groups });
}

// Mirrors background.js: aegis:save-group -> safely_append_to_groups —
// read-modify-write serialized through the service worker's AsyncMutex.
const storage_mutex = new AsyncMutex(5000);

async function safely_append_to_groups(username, new_group) {
  const unlock = await storage_mutex.lock();
  try {
    const groups = await get_tab_groups(username);
    groups.unshift(new_group);
    await save_tab_groups(username, groups);
  } finally {
    unlock();
  }
}

test('VULNERABILITY HUNT: Storage Race Condition', async () => {
  mockStorage.data['vaulttab_groups_testuser'] = [];
  const promises = [];
  for (let i = 0; i < 10; i++) {
    // each save goes through the SW mutex queue, exactly like popup.js does
    promises.push(safely_append_to_groups('testuser', { id: i, title: `Tab ${i}` }));
  }
  await Promise.all(promises);
  const final_groups = await get_tab_groups('testuser');
  assert.strictEqual(final_groups.length, 10, `Data loss from Race Condition! Expected 10 saved tabs, but only got ${final_groups.length}`);
});

test('control: the same 10 saves WITHOUT the mutex lose data (regression guard)', async () => {
  mockStorage.data['vaulttab_groups_bare'] = [];
  const unprotected = async (i) => {
    // exact race the test hunts: read once, write back stale
    const groups = await get_tab_groups('bare');
    groups.unshift({ id: i, title: `Tab ${i}` });
    await save_tab_groups('bare', groups);
  };
  await Promise.all(Array.from({ length: 10 }, (_, i) => unprotected(i)));
  const final_groups = await get_tab_groups('bare');
  assert.ok(final_groups.length < 10, 'control expected the unprotected path to lose writes — mock timing changed?');
});
