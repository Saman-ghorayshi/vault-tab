// background service worker for Aegis Tab
// handles right-click context menu, auto-lock timer, and centralized
// session lifecycle. popup and manager pages send unlock/lock requests
// via messages; the service worker is the sole writer of the session.

import {
  get_all_users, get_user_by_username, save_user,
  get_tab_groups, save_tab_groups,
  get_session_key, store_session_key, clear_session_key,
  get_session_user, set_session_user,
  get_settings
} from './common/storage.js';
import {
  derive_key_from_password, decrypt, encrypt, base64_to_array_buffer,
  OLD_ITERATIONS, CURRENT_ITERATIONS
} from './common/crypto.js';
import { get_url_status, derive_title_from_url } from './common/urls.js';

const VERIFIER_STRING = 'aegis-verification-string';

// --- auto-lock timer ---
let lock_timer = null;
let auto_lock_minutes = 0;

// start the countdown. called after every unlock or after settings change.
async function start_auto_lock_timer() {
  // cancel any existing timer
  if (lock_timer) {
    clearTimeout(lock_timer);
    lock_timer = null;
  }

  try {
    const stored = await get_settings();
    auto_lock_minutes = stored.auto_lock_minutes || 0;
  } catch (_) {
    auto_lock_minutes = 0;
  }

  if (auto_lock_minutes > 0) {
    lock_timer = setTimeout(async () => {
      // auto-lock: clear session and notify all open pages
      await clear_session_key();
      try {
        chrome.runtime.sendMessage({ type: 'aegis:locked' }).catch(() => {});
      } catch (_) {}
      lock_timer = null;
    }, auto_lock_minutes * 60 * 1000);
  }
}

// cancel the auto-lock timer (on explicit lock)
function cancel_auto_lock_timer() {
  if (lock_timer) {
    clearTimeout(lock_timer);
    lock_timer = null;
  }
}

// --- message-based session lifecycle ---
// popup and manager pages send these messages instead of writing the
// session directly. the service worker is the sole session writer.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'aegis:unlock': {
        // { type: 'aegis:unlock', username, password }
        try {
          const user = await get_user_by_username(message.username);
          if (!user) {
            // constant-time dummy derivation
            const dummy_salt = new Uint8Array(16);
            await derive_key_from_password('dummy_placeholder', dummy_salt, OLD_ITERATIONS);
            sendResponse({ ok: false, error: 'Invalid username or password' });
            return;
          }

          const salt = base64_to_array_buffer(user.password_salt);
          const iterations = user.password_iterations || OLD_ITERATIONS;
          const key = await derive_key_from_password(message.password, salt, iterations);
          const decrypted_verifier = await decrypt(user.password_verifier, key);

          if (decrypted_verifier !== VERIFIER_STRING) {
            sendResponse({ ok: false, error: 'Invalid username or password' });
            return;
          }

          // silent iteration upgrade
          if (iterations < CURRENT_ITERATIONS) {
            try {
              const new_key = await derive_key_from_password(message.password, salt, CURRENT_ITERATIONS);
              const new_verifier = await encrypt(VERIFIER_STRING, new_key);
              user.password_verifier = new_verifier;
              user.password_iterations = CURRENT_ITERATIONS;
              await save_user(user);
              await store_session_key(new_key);
            } catch (_) {
              await store_session_key(key);
            }
          } else {
            await store_session_key(key);
          }

          await set_session_user(message.username);
          start_auto_lock_timer();
          // broadcast unlock to all open pages
          chrome.runtime.sendMessage({ type: 'aegis:unlocked', username: message.username }).catch(() => {});
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
        break;
      }

      case 'aegis:lock': {
        cancel_auto_lock_timer();
        await clear_session_key();
        chrome.runtime.sendMessage({ type: 'aegis:locked' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'aegis:refresh-timer': {
        // called after settings change in the manager
        start_auto_lock_timer();
        sendResponse({ ok: true });
        break;
      }

      case 'aegis:reset-timer': {
        // called from the manager page on user activity — restart the countdown
        start_auto_lock_timer();
        sendResponse({ ok: true });
        break;
      }

      case 'aegis:session-state': {
        // popup/manager ask on startup: "am I already unlocked?"
        const key = await get_session_key();
        const user = await get_session_user();
        sendResponse({ ok: true, unlocked: !!(key && user), username: user });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();
  return true; // keep the message channel open for async response
});

// --- startup: if session exists, restart the auto-lock timer ---
(async () => {
  const key = await get_session_key();
  if (key) {
    start_auto_lock_timer();
  }
  create_context_menu();
})();

// create or recreate the context menu item
function create_context_menu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'aegis-save-current-tab',
      title: 'Save to Aegis Tab',
      contexts: ['page', 'link']
    });
  });
}

// also recreate the menu on install / update
chrome.runtime.onInstalled.addListener(() => {
  create_context_menu();
});

// handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'aegis-save-current-tab') return;

  try {
    const session_key = await get_session_key();
    const session_user = await get_session_user();

    if (!session_key || !session_user) {
      // not unlocked: open the popup so user can unlock
      chrome.action.openPopup?.();
      return;
    }

    // if right-clicked on a link, save the link url instead of the page
    const target_url = info.linkUrl || tab.url || tab.pendingUrl || '';

    if (!target_url) return; // nothing to save

    const status = get_url_status(target_url);

    // when saving a link, use the page title as a hint, fall back to hostname
    const page_title = info.linkUrl ? (tab.title || '') : tab.title;
    const title = derive_title_from_url(target_url, page_title);

    const tab_data = {
      date: new Date().toISOString(),
      tabs: [{
        id: crypto.randomUUID(),
        title: title,
        url: target_url,
        fav_icon_url: tab.favIconUrl || null,
        status: status
      }]
    };

    const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
    const groups = await get_tab_groups(session_user);
    groups.unshift({
      id: crypto.randomUUID(),
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext
    });
    await save_tab_groups(session_user, groups);
  } catch (error) {
    // context menu save failed -- cannot surface UI from service worker
    // error is logged to the extension's background console
    console.error('Aegis Tab: context menu save failed:', error);
  }
});
