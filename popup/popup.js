import {
  get_all_users, save_user, get_user_by_username,
  get_tab_groups, save_tab_groups,
  get_session_key, store_session_key, set_session_user, get_session_user,
  load_model
} from '../common/storage.js';
import {
  generate_salt, derive_key_from_password, encrypt, decrypt,
  array_buffer_to_base64, base64_to_array_buffer,
  OLD_ITERATIONS, CURRENT_ITERATIONS
} from '../common/crypto.js';
import { get_url_status, derive_title_from_url } from '../common/urls.js';

const VERIFIER_STRING = 'aegis-verification-string';
const MIN_PASSWORD_LENGTH = 8;

let aegis_toast_timeout = null;

// reusable toast helper for the popup.
// types: 'error' (red), 'success' (green), 'info' (accent).
function show_toast(message, type = 'info') {
  // remove any existing toast first
  const existing = document.getElementById('aegis-toast');
  if (existing) existing.remove();
  if (aegis_toast_timeout) clearTimeout(aegis_toast_timeout);

  const toast = document.createElement('div');
  toast.id = 'aegis-toast';
  toast.className = `aegis-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  aegis_toast_timeout = setTimeout(() => {
    toast.remove();
  }, 3500);
}

// render the account setup form and wire up validation + submit.
// auto_login=true for first-run (auto-locks into the new account);
// false when triggered from "Add Account" while already unlocked.
function render_setup_view(auto_login = true) {
  const setup_username = document.getElementById('setup-username');
  const setup_password = document.getElementById('setup-password');
  const setup_password_confirm = document.getElementById('setup-password-confirm');
  const setup_button = document.getElementById('setup-button');
  const setup_error = document.getElementById('setup-error');
  const setup_view = document.getElementById('setup-view');
  const locked_view = document.getElementById('locked-view');
  const unlocked_view = document.getElementById('unlocked-view');
  const current_user_label = document.getElementById('current-user-label');

  const unlock_view = document.getElementById('unlock-view');
  if (unlock_view) unlock_view.classList.add('hidden');
  setup_view.classList.remove('hidden');
  setup_error.classList.add('hidden');
  setup_username.value = '';
  setup_password.value = '';
  setup_password_confirm.value = '';
  setup_button.disabled = false;
  setup_button.textContent = 'Create Password';

  setTimeout(() => setup_username.focus(), 100);

  // enter-to-next navigation in setup fields
  setup_username.addEventListener('keydown', (e) => { if (e.key === 'Enter') setup_password.focus(); });
  setup_password.addEventListener('keydown', (e) => { if (e.key === 'Enter') setup_password_confirm.focus(); });
  setup_password_confirm.addEventListener('keydown', (e) => { if (e.key === 'Enter') setup_button.click(); });

  setup_button.addEventListener('click', () =>
    handle_setup_submit(setup_username, setup_password, setup_password_confirm,
      setup_button, setup_error, auto_login, setup_view, locked_view, unlocked_view, current_user_label)
  );
}

// shared account-creation logic used by first-run and "Add Account".
async function handle_setup_submit(u_el, p_el, pc_el, btn_el, err_el, auto_login,
  setup_view, locked_view, unlocked_view, current_user_label) {
  const username = u_el.value.trim();
  const password = p_el.value;
  const confirm_password = pc_el.value;

  err_el.classList.add('hidden');
  if (!username) {
    err_el.textContent = 'Please enter a username';
    err_el.classList.remove('hidden');
    return;
  }
  if (password !== confirm_password) {
    err_el.textContent = 'Passwords do not match';
    err_el.classList.remove('hidden');
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    err_el.textContent = 'Password must be at least 8 characters';
    err_el.classList.remove('hidden');
    return;
  }

  // reject duplicate usernames
  const existing = await get_user_by_username(username);
  if (existing) {
    err_el.textContent = 'An account with that username already exists';
    err_el.classList.remove('hidden');
    return;
  }

  btn_el.disabled = true;
  btn_el.textContent = 'Creating...';

  try {
    const salt = generate_salt();
    const key = await derive_key_from_password(password, salt, CURRENT_ITERATIONS);
    const verifier = await encrypt(VERIFIER_STRING, key);

    const new_user = {
      username: username,
      password_salt: array_buffer_to_base64(salt),
      password_verifier: verifier,
      password_iterations: CURRENT_ITERATIONS,
      tab_groups: []
    };
    await save_user(new_user);

    if (auto_login) {
      // first-run: log the user in automatically
      await store_session_key(key);
      await set_session_user(username);
      locked_view.classList.add('hidden');
      unlocked_view.classList.remove('hidden');
      if (current_user_label) current_user_label.textContent = username;
      setup_view.classList.add('hidden');
    } else {
      // adding from an already-unlocked session: stay on current account
      show_toast(`Account "${username}" created. Lock to switch to it.`, 'success');
      setup_view.classList.add('hidden');
      // show unlock view so they can lock and re-login as new user
      document.getElementById('unlock-view').classList.remove('hidden');
      // refresh the unlock dropdown
      refresh_unlock_user_list();
    }
  } catch (error) {
    err_el.textContent = `Setup failed: ${error.message}`;
    err_el.classList.remove('hidden');
    btn_el.disabled = false;
    btn_el.textContent = 'Create Password';
  }
}

// (re)populate the unlock screen's username dropdown from the current user list.
let is_refreshing_unlock_users = false;
async function refresh_unlock_user_list() {
  if (is_refreshing_unlock_users) return;
  is_refreshing_unlock_users = true;
  try {
    const select = document.getElementById('unlock-username-select');
    const wrapper = document.getElementById('unlock-username-wrapper');
    if (!select || !wrapper) return;
    const users = await get_all_users();
    select.innerHTML = '<option value="">Select user...</option>';
    if (users.length > 1) {
      wrapper.classList.remove('hidden');
      users.forEach(u => {
        const option = document.createElement('option');
        option.value = u.username;
        option.textContent = u.username;
        select.appendChild(option);
      });
    } else if (users.length === 1) {
      wrapper.classList.add('hidden');
      const option = document.createElement('option');
      option.value = users[0].username;
      option.textContent = users[0].username;
      select.appendChild(option);
      select.value = users[0].username;
    }
  } finally {
    is_refreshing_unlock_users = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const locked_view = document.getElementById('locked-view');
  const unlocked_view = document.getElementById('unlocked-view');
  const setup_view = document.getElementById('setup-view');
  const unlock_view = document.getElementById('unlock-view');
  const setup_error = document.getElementById('setup-error');
  const unlock_error = document.getElementById('unlock-error');

  const setup_username = document.getElementById('setup-username');
  const setup_password = document.getElementById('setup-password');
  const setup_password_confirm = document.getElementById('setup-password-confirm');
  const setup_button = document.getElementById('setup-button');

  const unlock_username_select = document.getElementById('unlock-username-select');
  const unlock_username_wrapper = document.getElementById('unlock-username-wrapper');
  const unlock_password = document.getElementById('unlock-password');
  const unlock_button = document.getElementById('unlock-button');

  const save_tabs_button = document.getElementById('save-tabs-button');
  const save_current_tab_button = document.getElementById('save-current-tab-button');
  const view_tabs_button = document.getElementById('view-tabs-button');
  const current_user_label = document.getElementById('current-user-label');

  // password eye toggle: click to reveal/hide password on any toggle button
  document.querySelectorAll('.password-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const target_input = document.getElementById(toggle.dataset.target);
      if (!target_input) return;
      if (target_input.type === 'password') {
        target_input.type = 'text';
        toggle.textContent = 'Hide';
      } else {
        target_input.type = 'password';
        toggle.textContent = 'Show';
      }
    });
  });

  // password strength meter
  const strength_bar = document.getElementById('password-strength-bar');
  const strength_text = document.getElementById('password-strength-text');
  if (setup_password && strength_bar) {
    setup_password.addEventListener('input', () => {
      const result = check_password_strength(setup_password.value);
      strength_bar.style.width = result.percentage + '%';
      strength_bar.style.backgroundColor = result.color;
      strength_text.textContent = result.label;
      strength_text.style.color = result.color;
    });
  }

  const all_users = await get_all_users();

  // check if a session is already active
  const session_key = await get_session_key();
  const session_user = await get_session_user();

  if (session_key && session_user) {
    // already unlocked
    locked_view.classList.add('hidden');
    unlocked_view.classList.remove('hidden');
    if (current_user_label) current_user_label.textContent = session_user;
  } else if (all_users.length === 0) {
      // first run: no users exist, show setup
      render_setup_view(true);
    } else {
    // returning user: show unlock with user dropdown
    unlock_view.classList.remove('hidden');

    // populate user dropdown if multiple users
    await refresh_unlock_user_list();

    setTimeout(() => unlock_password.focus(), 100);
    unlock_password.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock_button.click(); });

    unlock_button.addEventListener('click', async () => {
          const current_users = await get_all_users();
          const username = current_users.length === 1
            ? current_users[0].username
            : unlock_username_select.value;
          const password = unlock_password.value;
          unlock_error.classList.add('hidden');
          if (!password) {
            unlock_error.textContent = 'Please enter your password';
            unlock_error.classList.remove('hidden');
            return;
          }

          unlock_button.disabled = true;
          unlock_button.textContent = 'Unlocking...';

          try {
            // phase 1: password verification
            const response = await chrome.runtime.sendMessage({
              type: 'aegis:unlock', username, password
            });

            if (response?.needs_webauthn) {
              // server-side challenge needed for passkey assertion
              const { webauthn_credential_id, challenge } = response;
              const webauthn_module = await import(
                chrome.runtime.getURL('common/webauthn.js')
              );
              const options = webauthn_module.make_assertion_options(
                challenge, webauthn_credential_id
              );
              unlock_button.textContent = 'Verify with passkey...';

              // trigger the browser's native passkey dialog
              const credential = await navigator.credentials.get({ publicKey: options });
              if (!credential) throw new Error('Passkey cancelled');

              const serialized = webauthn_module.serialize_assertion(credential);
              const verify_response = await chrome.runtime.sendMessage({
                type: 'aegis:unlock-webauthn',
                assertion: serialized
              });
              if (!verify_response?.ok) throw new Error('Passkey verification failed');
            } else if (response?.ok) {
              // no passkey needed — unlocked directly
            } else {
              throw new Error(response?.error || 'Unlock failed');
            }

            locked_view.classList.add('hidden');
            unlocked_view.classList.remove('hidden');
            if (current_user_label) current_user_label.textContent = username;
          } catch (error) {
            unlock_error.textContent = error.message && error.message !== 'Unlock failed'
              ? (error.message === 'Passkey cancelled' ? 'WebAuthn cancelled' : error.message)
              : 'Invalid username or password';
            unlock_error.classList.remove('hidden');
          } finally {
            unlock_button.disabled = false;
            unlock_button.textContent = 'Unlock';
          }
        });
  }

  // AI semantic auto-naming: use the trained embedder to suggest a group name
  // for the given set of tabs. returns the suggested name string or null.
  async function try_suggest_group_name(tabs_to_save, session_user_el, session_key_el) {
    try {
      const saved_model = await load_model(session_user_el, session_key_el);
      if (saved_model && saved_model.is_trained) {
        const { LocalTabEmbedder } = await import(
          chrome.runtime.getURL('common/embedder.js')
        );
        const model = new LocalTabEmbedder();
        model.deserialize(saved_model);
        const suggested_name = model.suggest_group_name(tabs_to_save);
        if (suggested_name) return suggested_name;
      }
    } catch (_) {
      // auto-naming failed, fall back to date-based default
    }
    return null;
  }

  // save all open tabs in the current window, encrypted
  save_tabs_button.addEventListener('click', async () => {
    const session_key = await get_session_key();
    const session_user = await get_session_user();
    if (!session_key || !session_user) {
      locked_view.classList.remove('hidden');
      unlocked_view.classList.add('hidden');
      unlock_view.classList.remove('hidden');
      return;
    }

    save_tabs_button.disabled = true;
    save_tabs_button.textContent = 'Saving...';

    try {
      const all_tabs = await chrome.tabs.query({ currentWindow: true }) || [];
      const manager_url = chrome.runtime.getURL('manager_page/manager.html');

      const tabs_to_save = [];
      const tab_ids_to_remove = [];

      for (let i = 0; i < all_tabs.length; i++) {
        try {
          const tab = all_tabs[i];

          // fall back to pendingUrl if url is empty (tab still loading or just pasted)
          const target_url = tab.url || tab.pendingUrl || '';

          // skip completely empty tabs and the manager page itself
          if (!target_url || target_url === manager_url) continue;

          // determine saveable status
          const status = get_url_status(target_url);

          // use title from tab, or derive from url, or fallback placeholder
          const title = derive_title_from_url(target_url, tab.title);

          tabs_to_save.push({
            id: crypto.randomUUID(),
            title: title,
            url: target_url,
            fav_icon_url: tab.favIconUrl || null,
            status: status
          });
          // only close tabs that are actually restorable
          if (status === 'ok') {
            tab_ids_to_remove.push(tab.id);
          }
        } catch (per_tab_err) {
          // one bad tab must not abort the entire save
          continue;
        }
      }

      if (tabs_to_save.length === 0) {
        show_toast('No saveable tabs found in this window.', 'info');
        save_tabs_button.disabled = false;
        save_tabs_button.textContent = 'Save All Tabs';
        return;
      }

      // build the tab data payload and encrypt it
      const tab_data = {
        date: new Date().toISOString(),
        tabs: tabs_to_save
      };

      // AI semantic auto-naming: use the trained embedder to suggest a group name
      const suggested_name = await try_suggest_group_name(tabs_to_save, session_user, session_key);
      if (suggested_name) tab_data.name = suggested_name;

      const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
      const new_group = {
        id: crypto.randomUUID(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      };
      
      const response = await chrome.runtime.sendMessage({
        type: 'aegis:save-group',
        username: session_user,
        group: new_group
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || 'Failed to communicate with service worker');
      }

      // open the manager page, then close the saved tabs
      const manager_tab = await chrome.tabs.create({ url: manager_url });
      const final_ids_to_remove = tab_ids_to_remove.filter(id => id !== manager_tab.id);
      if (final_ids_to_remove.length > 0) {
        await chrome.tabs.remove(final_ids_to_remove);
      }

      window.close();
    } catch (error) {
      show_toast(`Failed to save tabs: ${error.message}`, 'error');
      save_tabs_button.disabled = false;
      save_tabs_button.textContent = 'Save All Tabs';
    }
  });

  // save only the currently active tab
  save_current_tab_button.addEventListener('click', async () => {
    const session_key = await get_session_key();
    const session_user = await get_session_user();
    if (!session_key || !session_user) {
      locked_view.classList.remove('hidden');
      unlocked_view.classList.add('hidden');
      unlock_view.classList.remove('hidden');
      return;
    }

    save_current_tab_button.disabled = true;
    save_current_tab_button.textContent = 'Saving...';

    try {
      const [active_tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active_tab) {
        show_toast('Could not find the active tab.', 'error');
        save_current_tab_button.disabled = false;
        save_current_tab_button.textContent = 'Save This Tab';
        return;
      }

      const target_url = active_tab.url || active_tab.pendingUrl || '';

      if (!target_url) {
        show_toast('This tab has no URL to save.', 'error');
        save_current_tab_button.disabled = false;
        save_current_tab_button.textContent = 'Save This Tab';
        return;
      }

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

      // AI semantic auto-naming (same as the save-all-tabs path)
      const suggested_name = await try_suggest_group_name(tab_data.tabs, session_user, session_key);
      if (suggested_name) tab_data.name = suggested_name;

      const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
      const new_group = {
        id: crypto.randomUUID(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      };
      
      const response = await chrome.runtime.sendMessage({
        type: 'aegis:save-group',
        username: session_user,
        group: new_group
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || 'Failed to communicate with service worker');
      }

      save_current_tab_button.textContent = 'Saved!';
      setTimeout(() => window.close(), 600);
    } catch (error) {
      show_toast(`Failed to save tab: ${error.message}`, 'error');
      save_current_tab_button.disabled = false;
      save_current_tab_button.textContent = 'Save This Tab';
    }
  });

  view_tabs_button.addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('manager_page/manager.html') });
      window.close();
    } catch (error) {
      show_toast(`Failed to open manager: ${error.message}`, 'error');
    }
  });

  // "Create a new account instead" link on the unlock screen
  const show_setup_link = document.getElementById('popup-show-setup-link');
  if (show_setup_link) {
    show_setup_link.addEventListener('click', (e) => {
      e.preventDefault();
      unlock_view.classList.add('hidden');
      render_setup_view(false);
    });
  }

  // "+ Add Account" button on the unlocked view
  const add_account_btn = document.getElementById('popup-add-account-button');
  if (add_account_btn) {
    add_account_btn.addEventListener('click', () => {
      unlocked_view.classList.add('hidden');
      locked_view.classList.remove('hidden');
      unlock_view.classList.add('hidden');
      render_setup_view(false);
    });
  }

  // Lock button on the unlocked view
  const lock_btn = document.getElementById('popup-lock-button');
  if (lock_btn) {
    lock_btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'aegis:lock' }).catch(() => {});
      unlocked_view.classList.add('hidden');
      locked_view.classList.remove('hidden');
      unlock_view.classList.remove('hidden');
      unlock_password.value = '';
      unlock_button.disabled = false;
      unlock_button.textContent = 'Unlock';
      await refresh_unlock_user_list();
    });
  }

  // listen for auto-lock or lock events from the service worker
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'aegis:locked') {
      // switch back to locked view if currently unlocked
      if (!unlocked_view.classList.contains('hidden')) {
        unlocked_view.classList.add('hidden');
        locked_view.classList.remove('hidden');
        unlock_view.classList.remove('hidden');
        unlock_password.value = '';
        unlock_button.disabled = false;
        unlock_button.textContent = 'Unlock';
        await refresh_unlock_user_list();
      }
    }
  });
});

// evaluate password strength and return label, color, and percentage
// checks length, character variety (upper, lower, digits, symbols)
function check_password_strength(password) {
  if (!password || password.length === 0) {
    return { label: '', color: 'var(--bg-tertiary)', percentage: 0 };
  }

  let score = 0;
  if (password.length >= 8) score += 25;
  if (password.length >= 12) score += 15;
  if (password.length >= 16) score += 10;

  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 15;
  if (/[0-9]/.test(password)) score += 15;
  if (/[^a-zA-Z0-9]/.test(password)) score += 10;

  if (score >= 80) {
    return { label: 'Strong', color: '#4caf50', percentage: 100 };
  } else if (score >= 50) {
    return { label: 'Medium', color: '#ff9800', percentage: 60 };
  } else if (score >= 25) {
    return { label: 'Weak', color: '#f44336', percentage: 30 };
  } else {
    return { label: 'Too short', color: '#f44336', percentage: 10 };
  }
}
