// idb_storage.js -- IndexedDB adapter for Aegis Tab
// Provides promise-based storage for large encrypted tab payloads
// that exceed chrome.storage.local quota limits.
// Database: aegis_tab_idb, Object store: tab_data

const DB_NAME = 'aegis_tab_idb';
const DB_VERSION = 1;
const STORE_NAME = 'tab_data';

let _db_instance = null;

// open or return cached database connection
function open_db() {
  if (_db_instance) return Promise.resolve(_db_instance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(new Error(`IndexedDB open failed: ${request.error?.message}`));

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => {
      _db_instance = request.result;
      _db_instance.onclose = () => { _db_instance = null; };
      _db_instance.onversionchange = () => {
        _db_instance.close();
        _db_instance = null;
      };
      resolve(_db_instance);
    };
  });
}

// store a value by key. overwrites if key already exists.
export async function idb_put(key, value) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`idb_put failed: ${tx.error?.message}`));
  });
}

// retrieve a value by key. returns undefined if not found.
export async function idb_get(key) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onerror = () => reject(new Error(`idb_get failed: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result);
  });
}

// delete a single key.
export async function idb_delete(key) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`idb_delete failed: ${tx.error?.message}`));
  });
}

// get all keys in the store.
export async function idb_get_all_keys() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onerror = () => reject(new Error(`idb_get_all_keys failed: ${request.error?.message}`));
    request.onsuccess = () => resolve(request.result || []);
  });
}

// delete all keys that start with the given prefix.
// used to clean up all data for a specific user.
export async function idb_delete_by_prefix(prefix) {
  const keys = await idb_get_all_keys();
  const matching = keys.filter(k => typeof k === 'string' && k.startsWith(prefix));
  if (matching.length === 0) return;

  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const key of matching) {
      store.delete(key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`idb_delete_by_prefix failed: ${tx.error?.message}`));
  });
}

// store a large JSON string by splitting it into chunks.
// stores a manifest at the base key and chunks at key_0, key_1, etc.
// chunk_size is in characters.
export async function idb_put_chunked(key, json_string, chunk_size = 1024 * 1024) {
  const chunk_count = Math.ceil(json_string.length / chunk_size);
  const db = await open_db();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    for (let i = 0; i < chunk_count; i++) {
      const chunk = json_string.slice(i * chunk_size, (i + 1) * chunk_size);
      store.put(chunk, `${key}_${i}`);
    }

    // write manifest
    store.put({ _chunked: true, chunk_count: chunk_count }, key);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`idb_put_chunked failed: ${tx.error?.message}`));
  });
}

// retrieve a chunked value by reading the manifest and reassembling.
// returns null if the key does not exist.
export async function idb_get_chunked(key) {
  const manifest = await idb_get(key);
  if (!manifest) return null;

  // not a chunked manifest -- return directly
  if (!manifest._chunked) return manifest;

  const db = await open_db();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    let pending = manifest.chunk_count;
    const results = new Array(pending);

    for (let i = 0; i < manifest.chunk_count; i++) {
      const request = store.get(`${key}_${i}`);
      const idx = i;
      request.onsuccess = () => {
        results[idx] = request.result || '';
        pending--;
        if (pending === 0) {
          resolve(results.join(''));
        }
      };
      request.onerror = () => reject(new Error(`idb_get_chunked: chunk ${idx} failed`));
    }
  });
}

// delete a chunked value (manifest + all chunks).
export async function idb_delete_chunked(key) {
  const manifest = await idb_get(key);
  if (!manifest) return;

  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    store.delete(key);
    if (manifest._chunked) {
      for (let i = 0; i < manifest.chunk_count; i++) {
        store.delete(`${key}_${i}`);
      }
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(`idb_delete_chunked failed: ${tx.error?.message}`));
  });
}
