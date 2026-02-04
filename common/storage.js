import { exportKey, importKey } from './crypto.js';

// --- Persistent Local Storage ---
export async function getCredentials() {
  const result = await chrome.storage.local.get('aegis_credentials');
  return result.aegis_credentials || null;
}

export async function saveCredentials(credentialsObject) {
  return chrome.storage.local.set({ aegis_credentials: credentialsObject });
}

export async function getTabGroups() {
  const result = await chrome.storage.local.get('aegis_tab_groups');
  return result.aegis_tab_groups || [];
}

export async function saveTabGroups(tabGroupsArray) {
  return chrome.storage.local.set({ aegis_tab_groups: tabGroupsArray });
}

// --- In-Memory Session Storage ---
// Centralize session key management here.
export async function getSessionKey() {
  const result = await chrome.storage.session.get('aegis_session_key');
  const keyBuffer = result.aegis_session_key || null;
  if (keyBuffer) {
    const key = await importKey(keyBuffer);
    console.log("Retrieved and imported session key. Type:", typeof key, key);
    return key;
  }
  console.log("No session key found in storage.");
  return null;
}

export async function storeSessionKey(key) {
  console.log("Storing session key. Type:", typeof key, key);
  const keyBuffer = await exportKey(key);
  return chrome.storage.session.set({ aegis_session_key: keyBuffer });
}

