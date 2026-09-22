import test from 'node:test';
import assert from 'node:assert';

// Simulate Chrome Storage Local with artificial async delays
const mockStorage = {
  data: { 'vaulttab_groups_testuser': [] },
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

// This simulates the exact code in popup.js and background.js
async function simulate_save_tab(tab_id) {
  const groups = await get_tab_groups('testuser');
  groups.unshift({ id: tab_id, title: `Tab ${tab_id}` });
  await save_tab_groups('testuser', groups);
}

test('VULNERABILITY HUNT: Storage Race Condition', async () => {
  // Fire 10 saves completely concurrently
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(simulate_save_tab(i));
  }
  
  await Promise.all(promises);
  
  const final_groups = await get_tab_groups('testuser');
  
  // If our code is protected against race conditions, we should have 10 tabs.
  // Because Chrome Storage is async and disconnected between context scripts, 
  // without a mutex or delegation, this will definitely fail!
  assert.strictEqual(final_groups.length, 10, `Data loss from Race Condition! Expected 10 saved tabs, but only got ${final_groups.length}`);
});
