import { export_key, import_key } from './crypto.js';

// storage keys
const STORAGE_KEYS = {
  users: 'aegis_users',
  tab_groups: 'aegis_tab_groups',
  session_key: 'aegis_session_key',
  session_user: 'aegis_session_user',
  settings: 'aegis_settings',
  model: 'aegis_model'
};

// --- migration: convert old single-user format to multi-user format ---
// the old format stored a single credentials object in aegis_credentials.
// the new format stores an array of users in aegis_users.
// each user has their own username, salt, verifier, and tab groups.
// this runs once on first load after the update.
async function migrate_old_format() {
  const old_data = await chrome.storage.local.get('aegis_credentials');
  if (!old_data.aegis_credentials) return;

  // check if migration was already done
  const existing_users = await chrome.storage.local.get(STORAGE_KEYS.users);
  if (existing_users[STORAGE_KEYS.users]) return;

  // convert the old credentials to the new user format
  const old_creds = old_data.aegis_credentials;
  const migrated_user = {
    username: 'default',
    password_salt: old_creds.password_salt || old_creds.passwordSalt,
    password_verifier: old_creds.password_verifier || old_creds.passwordVerifier,
    tab_groups: await get_raw_tab_groups()
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.users]: [migrated_user] });

  // clear old keys to avoid confusion
  await chrome.storage.local.remove('aegis_credentials');
  await chrome.storage.local.remove('aegis_tab_groups');
}

// --- internal helper: get raw tab groups (not tied to a user) ---
async function get_raw_tab_groups() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.tab_groups);
  return result[STORAGE_KEYS.tab_groups] || [];
}

// --- user management ---

export async function get_all_users() {
  await migrate_old_format();
  const result = await chrome.storage.local.get(STORAGE_KEYS.users);
  return result[STORAGE_KEYS.users] || [];
}

export async function save_all_users(users_array) {
  return chrome.storage.local.set({ [STORAGE_KEYS.users]: users_array });
}

export async function get_user_by_username(username) {
  const users = await get_all_users();
  return users.find(u => u.username === username) || null;
}

export async function save_user(user_object) {
  const users = await get_all_users();
  const index = users.findIndex(u => u.username === user_object.username);
  if (index >= 0) {
    users[index] = user_object;
  } else {
    users.push(user_object);
  }
  return save_all_users(users);
}

export async function delete_user(username) {
  const users = await get_all_users();
  const filtered = users.filter(u => u.username !== username);
  await save_all_users(filtered);
}

// --- per-user tab groups ---

export async function get_tab_groups(username) {
  const user = await get_user_by_username(username);
  if (!user) return [];
  // if the user has tab_groups stored on the user object, use those
  if (user.tab_groups) return user.tab_groups;
  // fallback: check the old global storage (for migrated users without groups yet)
  return await get_raw_tab_groups();
}

export async function save_tab_groups(username, tab_groups_array) {
  const user = await get_user_by_username(username);
  if (!user) return;
  user.tab_groups = tab_groups_array;
  return save_user(user);
}

// --- in-memory session storage ---

export async function get_session_key() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.session_key);
  const key_buffer = result[STORAGE_KEYS.session_key] || null;
  if (!key_buffer) return null;
  return import_key(key_buffer);
}

export async function store_session_key(key) {
  const key_buffer = await export_key(key);
  return chrome.storage.session.set({ [STORAGE_KEYS.session_key]: key_buffer });
}

export async function clear_session_key() {
  await chrome.storage.session.remove(STORAGE_KEYS.session_key);
  await chrome.storage.session.remove(STORAGE_KEYS.session_user);
  return;
}

// store which username is currently unlocked
export async function set_session_user(username) {
  return chrome.storage.session.set({ [STORAGE_KEYS.session_user]: username });
}

export async function get_session_user() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.session_user);
  return result[STORAGE_KEYS.session_user] || null;
}

// --- settings (global, not per-user) ---

export async function get_settings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return result[STORAGE_KEYS.settings] || { always_private: false, auto_lock_minutes: 0 };
}

export async function save_settings(settings_object) {
  return chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings_object });
}

// --- model persistence ---

// save the trained neural network model to local storage
export async function save_model(model_data) {
  return chrome.storage.local.set({ [STORAGE_KEYS.model]: model_data });
}

// load the trained model from local storage
export async function load_model() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.model);
  return result[STORAGE_KEYS.model] || null;
}

// delete the stored model
export async function clear_model() {
  return chrome.storage.local.remove(STORAGE_KEYS.model);
}
