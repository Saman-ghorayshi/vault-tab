import { export_key, import_key } from './crypto.js';

// storage keys
const STORAGE_KEYS = {
  credentials: 'aegis_credentials',
  tab_groups: 'aegis_tab_groups',
  session_key: 'aegis_session_key',
  settings: 'aegis_settings'
};

// --- persistent local storage ---

export async function get_credentials() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.credentials);
  return result[STORAGE_KEYS.credentials] || null;
}

export async function save_credentials(credentials_object) {
  return chrome.storage.local.set({ [STORAGE_KEYS.credentials]: credentials_object });
}

export async function get_tab_groups() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.tab_groups);
  return result[STORAGE_KEYS.tab_groups] || [];
}

export async function save_tab_groups(tab_groups_array) {
  return chrome.storage.local.set({ [STORAGE_KEYS.tab_groups]: tab_groups_array });
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

// clear the session key when locking or on errors
export async function clear_session_key() {
  return chrome.storage.session.remove(STORAGE_KEYS.session_key);
}

// --- settings ---

export async function get_settings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return result[STORAGE_KEYS.settings] || { always_private: false };
}

export async function save_settings(settings_object) {
  return chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings_object });
}
