import { export_key, import_key, encrypt, decrypt } from './crypto.js';
import { idb_put_chunked, idb_get_chunked, idb_delete_chunked } from './idb_storage.js';

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
// cached so subsequent calls skip the storage round-trip entirely.
let _migration_done = false;

async function migrate_old_format() {
  if (_migration_done) return;

  const old_data = await chrome.storage.local.get('aegis_credentials');
  if (!old_data.aegis_credentials) {
    _migration_done = true;
    return;
  }

  // check if migration was already done
  const existing_users = await chrome.storage.local.get(STORAGE_KEYS.users);
  if (existing_users[STORAGE_KEYS.users]) {
    _migration_done = true;
    return;
  }

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
  _migration_done = true;
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
  const raw = result[STORAGE_KEYS.users] || [];
  const seen = new Set();
  const deduplicated = [];
  for (const u of raw) {
    if (u && u.username && !seen.has(u.username)) {
      seen.add(u.username);
      deduplicated.push(u);
    }
  }
  if (deduplicated.length !== raw.length) {
    await save_all_users(deduplicated);
  }
  return deduplicated;
}

export function is_valid_username(username) {
  if (!username || typeof username !== 'string') return false;
  const trimmed = username.trim();
  if (trimmed.length < 2 || trimmed.length > 32) return false;
  if (trimmed === '__proto__' || trimmed === 'prototype' || trimmed === 'constructor') return false;
  return /^[a-zA-Z0-9_\-\.]+$/.test(trimmed);
}

export async function save_all_users(users_array) {
  return chrome.storage.local.set({ [STORAGE_KEYS.users]: users_array });
}

export async function get_user_by_username(username) {
  if (!is_valid_username(username)) return null;
  const users = await get_all_users();
  return users.find(u => u.username === username) || null;
}

export async function save_user(user_object) {
  if (!user_object || !is_valid_username(user_object.username)) {
    throw new Error('Invalid user object: username must be alphanumeric (2-32 chars)');
  }
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
  const target = users.find(u => u.username === username);
  // clean up any IDB-stored tab groups before removing the user record
  if (target && target.tab_groups === IDB_MARKER) {
    idb_delete_chunked(`tabgroups_${username}`).catch(() => {});
  }
  const filtered = users.filter(u => u.username !== username);
  await save_all_users(filtered);
  // if no users remain, clean up any leftover shared model data
  if (filtered.length === 0) {
    clear_model().catch(() => {});
  }
  // also clean up this specific user's own model key
  clear_model(username).catch(() => {});
}

// IDB marker: when tab_groups are stored in IndexedDB, the user object
// holds this sentinel instead of the actual array.
const IDB_MARKER = '__aegis_idb__';

export async function get_tab_groups(username) {
  const user = await get_user_by_username(username);
  if (!user) return [];

  // check if groups are in IndexedDB
  if (user.tab_groups === IDB_MARKER) {
    try {
      const json_str = await idb_get_chunked(`tabgroups_${username}`);
      if (json_str) return JSON.parse(json_str);
    } catch (_) {
      // IDB read failed, return empty
    }
    return [];
  }

  if (user.tab_groups) return user.tab_groups;
  // fallback: check the old global storage (for migrated users without groups yet)
  return await get_raw_tab_groups();
}

export async function save_tab_groups(username, tab_groups_array) {
  const user = await get_user_by_username(username);
  if (!user) {
    throw new Error(`save_tab_groups: user "${username}" not found. Data not saved.`);
  }

  // attempt chrome.storage.local first
  try {
    user.tab_groups = tab_groups_array;
    await save_user(user);

    // if a previous save had fallen back to IDB, clean up the orphaned IDB data
    idb_delete_chunked(`tabgroups_${username}`).catch(() => {});
    return;
  } catch (err) {
    // chrome.storage.local failed (quota or write error)
    // fall through to IndexedDB
  }

  // IndexedDB failover: store groups in IDB, put a marker on the user object
  try {
    const json_str = JSON.stringify(tab_groups_array);
    await idb_put_chunked(`tabgroups_${username}`, json_str);
    user.tab_groups = IDB_MARKER;
    await save_user(user);
  } catch (idb_err) {
    throw new Error(`save_tab_groups: both chrome.storage and IndexedDB failed. ${idb_err.message}`);
  }
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

// build the per-user model storage key, mirroring the tabgroups_<username>
// IDB pattern so each account's trained model stays isolated.
function model_storage_key(username) {
  return `aegis_model_${username}`;
}

// save the trained neural network model for a specific user.
// the serialized model is encrypted with the session key before storage,
// the same way tab groups are — the model's vocabulary is derived from
// the user's tab/URL data, so leaving it in plaintext would leak that data
// to anyone who can read chrome.storage.local.
// falls back to IndexedDB if chrome.storage.local fails (model can be large).
export async function save_model(username, model_data, session_key) {
  const key = model_storage_key(username);
  // encrypt the serialized model so it's ciphertext at rest
  const encrypted = session_key
    ? await encrypt(JSON.stringify(model_data), session_key)
    : JSON.stringify(model_data);

  try {
    await chrome.storage.local.set({ [key]: encrypted });
    idb_delete_chunked(key).catch(() => {});
  } catch (_) {
    // chrome.storage.local failed, fall back to IDB
    // store the already-encrypted envelope as a JSON string
    const json_str = JSON.stringify(encrypted);
    await idb_put_chunked(key, json_str);
    // remove the key from chrome.storage to avoid partial state
    await chrome.storage.local.remove(key).catch(() => {});
  }

  // migration: if the old unscoped global model key still exists, delete it
  // outright. we don't try to guess which account it belonged to — a missing
  // model just means "not trained yet", which is a safe, cheap-to-recover
  // state (retraining takes seconds via the Train Model button).
  migrate_old_global_model().catch(() => {});
}

// load a user's trained model from local storage or IndexedDB and decrypt it.
export async function load_model(username, session_key) {
  const key = model_storage_key(username);
  const result = await chrome.storage.local.get(key);
  let stored = result[key];

  // check IndexedDB fallback if not in local storage
  if (!stored) {
    try {
      const json_str = await idb_get_chunked(key);
      if (json_str) stored = JSON.parse(json_str);
    } catch (_) {
      // IDB read failed
    }
  }

  if (!stored) return null;

  // decrypt if we have a session key and the stored value looks like an
  // encrypted envelope { iv, ciphertext }. an old plaintext model (from
  // before encryption was added) would be a plain object, but it belonged to
  // the global key which we deleted during migration, so it shouldn't reach
  // here. still, guard against it defensively.
  if (session_key && stored && typeof stored === 'object' && stored.iv && stored.ciphertext) {
    try {
      const json_str = await decrypt(stored, session_key);
      return JSON.parse(json_str);
    } catch (_) {
      // decryption failed (wrong key or corrupted) — return null so the
      // caller treats it as "not trained yet" rather than crashing
      return null;
    }
  }

  // if no session key was passed, return the raw envelope (caller handles it)
  // or if it's somehow already a plain model object, return as-is
  return stored;
}

// delete a user's trained model from both storage backends.
export async function clear_model(username) {
  // if called with no username, clean up the old global key (legacy)
  if (!username) {
    await chrome.storage.local.remove(STORAGE_KEYS.model).catch(() => {});
    await idb_delete_chunked('aegis_model').catch(() => {});
    return;
  }
  const key = model_storage_key(username);
  await chrome.storage.local.remove(key).catch(() => {});
  await idb_delete_chunked(key).catch(() => {});
}

// one-time cleanup of the old unscoped global model key from before
// per-user scoping was added. silently deletes it — no migration to any
// specific user because we can't know which account trained it.
let _global_model_migration_done = false;
async function migrate_old_global_model() {
  if (_global_model_migration_done) return;
  _global_model_migration_done = true;
  await chrome.storage.local.remove(STORAGE_KEYS.model).catch(() => {});
  await idb_delete_chunked('aegis_model').catch(() => {});
}

// purge groups that have expired (TTL) or all burner groups (during panic wipe)
export async function purge_expired_or_burner_groups(username, purge_all_burners = false) {
  const groups = await get_tab_groups(username);
  if (!groups || groups.length === 0) return 0;

  const now = Date.now();
  const kept = [];
  let purged_count = 0;

  for (const group of groups) {
    const is_expired = group.expires_at && now >= group.expires_at;
    const should_purge = (purge_all_burners && group.is_burner) || is_expired;

    if (should_purge) {
      purged_count++;
    } else {
      kept.push(group);
    }
  }

  if (purged_count > 0) {
    await save_tab_groups(username, kept);
  }
  return purged_count;
}

// delete a single group by ID (e.g. burn-on-restore)
export async function delete_tab_group_by_id(username, group_id) {
  const groups = await get_tab_groups(username);
  const updated = groups.filter(g => g.id !== group_id);
  if (updated.length !== groups.length) {
    await save_tab_groups(username, updated);
    return true;
  }
  return false;
}
