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
import { generate_challenge, verify_assertion, make_registration_options } from './common/webauthn.js';

const VERIFIER_STRING = 'aegis-verification-string';

// --- pending unlock state ---
// holds the derived key, username, and webauthn challenge between
// password verification and passkey assertion. cleared on lock,
// successful completion, or challenge timeout.
let pending_unlock = null;
let pending_unlock_credential = null;
let auto_lock_minutes = 0;

const AUTO_LOCK_ALARM = 'aegis_auto_lock';

// start the countdown. called after every unlock or after settings change.
// uses chrome.alarms (not setTimeout) because the service worker gets
// suspended by chrome after ~30s of inactivity — a setTimeout would die
// with it and the vault would never auto-lock. alarms survive suspension.
async function start_auto_lock_timer() {
  // cancel any existing alarm
  try {
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
  } catch (_) {}

  try {
    const stored = await get_settings();
    auto_lock_minutes = stored.auto_lock_minutes || 0;
  } catch (_) {
    auto_lock_minutes = 0;
  }

  if (auto_lock_minutes > 0) {
    // delayInMinutes is the minimum for chrome.alarms (chrome rounds
    // up to the next minute in some builds, but that's fine for an
    // auto-lock that's measured in minutes anyway).
    chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: auto_lock_minutes });
  }
}

// cancel the auto-lock alarm (on explicit lock)
async function cancel_auto_lock_timer() {
  try {
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
  } catch (_) {}
}

// fire the auto-lock when the alarm fires — this works even if the
// service worker was suspended and chrome woke it up just for this.
// also handles challenge expiry alarms (webauthn unlock + registration)
// that clear stale challenge state so derived keys don't linger forever.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) {
    await clear_session_key();
    try {
      chrome.runtime.sendMessage({ type: 'aegis:locked' }).catch(() => {});
    } catch (_) {}
  } else if (alarm.name === 'aegis_challenge_expiry') {
    // webauthn unlock challenge expired — clear the pending unlock state
    // so the derived key doesn't sit in memory forever.
    pending_unlock = null;
  } else if (alarm.name === 'aegis_reg_challenge_expiry') {
    // webauthn registration challenge expired — same cleanup.
    pending_unlock_credential = null;
  }
});

// --- message-based session lifecycle ---
// popup and manager pages send these messages instead of writing the
// session directly. the service worker is the sole session writer.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'aegis:unlock': {
        // { type: 'aegis:unlock', username, password }
        // phase 1: password verification. webauthn second-factor
        // (if registered) happens in a follow-up 'aegis:unlock-webauthn'
        // message from the client.
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
              // stash the derived key for either immediate use or
              // the webauthn second-factor pending phase
              pending_unlock = { username: message.username, key: new_key };
            } catch (_) {
              pending_unlock = { username: message.username, key };
            }
          } else {
            pending_unlock = { username: message.username, key };
          }

          // if this user has a registered passkey, send a webauthn challenge
          // instead of finishing unlock immediately.
          if (user.webauthn?.credential_id && user.webauthn?.public_key_cbor) {
            const challenge = generate_challenge();
            pending_unlock.challenge = challenge;
            // expire the challenge after 2 minutes using chrome.alarms
            // (not setTimeout) — the service worker can be suspended by
            // chrome between events, and a setTimeout timer would be
            // killed along with it, leaving the challenge and its derived
            // key stuck in memory indefinitely.
            chrome.alarms.create('aegis_challenge_expiry', { delayInMinutes: 2 });
            sendResponse({
              ok: true,
              needs_webauthn: true,
              webauthn_credential_id: user.webauthn.credential_id,
              challenge
            });
          } else {
            // no passkey registered — finish unlock immediately
            await store_session_key(pending_unlock.key);
            await set_session_user(pending_unlock.username);
            start_auto_lock_timer();
            chrome.runtime.sendMessage({
              type: 'aegis:unlocked',
              username: pending_unlock.username
            }).catch(() => {});
            pending_unlock = null;
            sendResponse({ ok: true });
          }
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
        break;
      }

      case 'aegis:unlock-webauthn': {
        // { type: 'aegis:unlock-webauthn', assertion: {...serialized...} }
        // after password verified, client runs navigator.credentials.get()
        // and sends us the signed assertion for verification.
        try {
          if (!pending_unlock || !pending_unlock.challenge) {
            sendResponse({ ok: false, error: 'No pending webauthn challenge' });
            return;
          }
          const user = await get_user_by_username(pending_unlock.username);
          if (!user || !user.webauthn?.public_key_cbor) {
            sendResponse({ ok: false, error: 'WebAuthn not registered for this account' });
            return;
          }

          const origin = `chrome-extension://${chrome.runtime.id}`;
          const valid = await verify_assertion(
            user.webauthn.public_key_cbor,
            pending_unlock.challenge,
            message.assertion,
            origin
          );

          if (!valid) {
            sendResponse({ ok: false, error: 'WebAuthn verification failed' });
            pending_unlock = null;
            return;
          }

          await store_session_key(pending_unlock.key);
          await set_session_user(pending_unlock.username);
          start_auto_lock_timer();
          chrome.runtime.sendMessage({
            type: 'aegis:unlocked',
            username: pending_unlock.username
          }).catch(() => {});
          pending_unlock = null;
          sendResponse({ ok: true });
        } catch (error) {
          pending_unlock = null;
          sendResponse({ ok: false, error: error.message });
        }
        break;
      }

      case 'aegis:lock': {
        // clear any pending unlock state too — if the user verified their
        // password but locked before finishing the webauthn second factor,
        // the derived key sitting in pending_unlock must not survive the lock.
        pending_unlock = null;
        pending_unlock_credential = null;
        await cancel_auto_lock_timer();
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

      case 'aegis:register-webauthn-start': {
        // generate a registration challenge for the current user
        try {
          if (!pending_unlock_credential) {
            // simple in-memory store for pending registration
            pending_unlock_credential = {};
          }
          const challenge = generate_challenge();
          pending_unlock_credential.challenge = challenge;
          // same alarm-based expiry as the unlock challenge — see comment above.
          chrome.alarms.create('aegis_reg_challenge_expiry', { delayInMinutes: 2 });
          sendResponse({ ok: true, challenge });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
        break;
      }

      case 'aegis:register-webauthn-complete': {
        // store the credential after successful browser-side registration
        try {
          const session_user = await get_session_user();
          if (!session_user) {
            sendResponse({ ok: false, error: 'Not logged in' });
            return;
          }
          if (!pending_unlock_credential) {
            sendResponse({ ok: false, error: 'No pending registration' });
            return;
          }
          const user = await get_user_by_username(session_user);
          if (!user) {
            sendResponse({ ok: false, error: 'User not found' });
            return;
          }

          // parse the attestation response to get the public key
          const { credential_id, public_key_cbor } = message;
          if (!credential_id || !public_key_cbor) {
            sendResponse({ ok: false, error: 'Missing credential data' });
            return;
          }

          user.webauthn = {
            credential_id,
            public_key_cbor
          };
          await save_user(user);
          pending_unlock_credential = null;
          sendResponse({ ok: true });
        } catch (error) {
          pending_unlock_credential = null;
          sendResponse({ ok: false, error: error.message });
        }
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

// handle keyboard shortcuts (commands)
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const session_key = await get_session_key();
    const session_user = await get_session_user();

    if (!session_key || !session_user) {
      chrome.action.openPopup?.();
      return;
    }

    if (command === 'save_current_tab') {
      const [active_tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active_tab) return;
      const target_url = active_tab.url || active_tab.pendingUrl || '';
      if (!target_url) return;
      const status = get_url_status(target_url);
      const title = derive_title_from_url(target_url, active_tab.title);

      const tab_data = {
        date: new Date().toISOString(),
        tabs: [{
          id: crypto.randomUUID(),
          title: title,
          url: target_url,
          fav_icon_url: active_tab.favIconUrl || null,
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
    } else if (command === 'save_all_tabs') {
      const all_tabs = await chrome.tabs.query({ currentWindow: true }) || [];
      const manager_url = chrome.runtime.getURL('manager_page/manager.html');

      const tabs_to_save = [];
      const tab_ids_to_remove = [];

      for (const tab of all_tabs) {
        const target_url = tab.url || tab.pendingUrl || '';
        if (!target_url || target_url === manager_url) continue;
        const status = get_url_status(target_url);
        const title = derive_title_from_url(target_url, tab.title);

        tabs_to_save.push({
          id: crypto.randomUUID(),
          title: title,
          url: target_url,
          fav_icon_url: tab.favIconUrl || null,
          status: status
        });
        if (status === 'ok') {
          tab_ids_to_remove.push(tab.id);
        }
      }

      if (tabs_to_save.length === 0) return;

      const tab_data = {
        date: new Date().toISOString(),
        tabs: tabs_to_save
      };

      const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
      const groups = await get_tab_groups(session_user);
      groups.unshift({
        id: crypto.randomUUID(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      });
      await save_tab_groups(session_user, groups);

      const manager_tab = await chrome.tabs.create({ url: manager_url });
      const final_ids = tab_ids_to_remove.filter(id => id !== manager_tab.id);
      if (final_ids.length > 0) {
        await chrome.tabs.remove(final_ids);
      }
    }
  } catch (err) {
    console.error('Aegis Tab shortcut error:', err);
  }
});
