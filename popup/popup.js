import {
  get_all_users, save_user, get_user_by_username,
  get_tab_groups, save_tab_groups,
  get_session_key, store_session_key, set_session_user, get_session_user
} from '../common/storage.js';
import {
  generate_salt, derive_key_from_password, encrypt, decrypt,
  array_buffer_to_base64, base64_to_array_buffer
} from '../common/crypto.js';

const VERIFIER_STRING = 'aegis-verification-string';
const MIN_PASSWORD_LENGTH = 8;

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
    setup_view.classList.remove('hidden');
    setTimeout(() => setup_username.focus(), 100);

    setup_username.addEventListener('keypress', (e) => { if (e.key === 'Enter') setup_password.focus(); });
    setup_password.addEventListener('keypress', (e) => { if (e.key === 'Enter') setup_password_confirm.focus(); });
    setup_password_confirm.addEventListener('keypress', (e) => { if (e.key === 'Enter') setup_button.click(); });

    setup_button.addEventListener('click', async () => {
      const username = setup_username.value.trim();
      const password = setup_password.value;
      const confirm_password = setup_password_confirm.value;

      setup_error.classList.add('hidden');
      if (!username) {
        setup_error.textContent = 'Please enter a username';
        setup_error.classList.remove('hidden');
        return;
      }
      if (password !== confirm_password) {
        setup_error.textContent = 'Passwords do not match';
        setup_error.classList.remove('hidden');
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        setup_error.textContent = 'Password must be at least 8 characters';
        setup_error.classList.remove('hidden');
        return;
      }

      setup_button.disabled = true;
      setup_button.textContent = 'Creating...';

      try {
        const salt = generate_salt();
        const key = await derive_key_from_password(password, salt);
        const verifier = await encrypt(VERIFIER_STRING, key);

        const new_user = {
          username: username,
          password_salt: array_buffer_to_base64(salt),
          password_verifier: verifier,
          tab_groups: []
        };
        await save_user(new_user);
        await store_session_key(key);
        await set_session_user(username);

        locked_view.classList.add('hidden');
        unlocked_view.classList.remove('hidden');
        if (current_user_label) current_user_label.textContent = username;
      } catch (error) {
        setup_error.textContent = `Setup failed: ${error.message}`;
        setup_error.classList.remove('hidden');
        setup_button.disabled = false;
        setup_button.textContent = 'Create Password';
      }
    });
  } else {
    // returning user: show unlock with user dropdown
    unlock_view.classList.remove('hidden');

    // populate user dropdown if multiple users
    if (all_users.length > 1 && unlock_username_select) {
      unlock_username_wrapper.classList.remove('hidden');
      all_users.forEach(u => {
        const option = document.createElement('option');
        option.value = u.username;
        option.textContent = u.username;
        unlock_username_select.appendChild(option);
      });
    } else if (all_users.length === 1 && unlock_username_select) {
      // single user: pre-fill but hide the dropdown
      unlock_username_select.value = all_users[0].username;
    }

    setTimeout(() => unlock_password.focus(), 100);
    unlock_password.addEventListener('keypress', (e) => { if (e.key === 'Enter') unlock_button.click(); });

    unlock_button.addEventListener('click', async () => {
      const username = all_users.length === 1
        ? all_users[0].username
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
        const user = await get_user_by_username(username);
        if (!user) throw new Error('User not found');

        const salt = base64_to_array_buffer(user.password_salt);
        const key = await derive_key_from_password(password, salt);
        const decrypted_verifier = await decrypt(user.password_verifier, key);

        if (decrypted_verifier === VERIFIER_STRING) {
          await store_session_key(key);
          await set_session_user(username);
          locked_view.classList.add('hidden');
          unlocked_view.classList.remove('hidden');
          if (current_user_label) current_user_label.textContent = username;
        } else {
          throw new Error('Decryption failed');
        }
      } catch (error) {
        unlock_error.textContent = 'Incorrect password';
        unlock_error.classList.remove('hidden');
        unlock_button.disabled = false;
        unlock_button.textContent = 'Unlock';
      }
    });
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
      const all_tabs = await chrome.tabs.query({ currentWindow: true });
      const manager_url = chrome.runtime.getURL('manager_page/manager.html');

      const tabs_to_save = [];
      const tab_ids_to_remove = [];

      for (let i = 0; i < all_tabs.length; i++) {
        const tab = all_tabs[i];

        // fall back to pendingUrl if url is empty (tab still loading or just pasted)
        const target_url = tab.url || tab.pendingUrl || '';

        // skip empty, system, and extension urls
        if (!target_url ||
            target_url.startsWith('chrome://') ||
            target_url.startsWith('chrome-extension://') ||
            target_url.startsWith('about:') ||
            target_url.startsWith('edge://') ||
            target_url.startsWith('about:blank')) {
          continue;
        }

        // use title from tab, or derive from url, or fallback placeholder
        let title = tab.title;
        if (!title || title.trim() === '') {
          try { title = new URL(target_url).hostname; } catch (e) { title = 'Untitled'; }
        }

        tabs_to_save.push({
          title: title,
          url: target_url,
          fav_icon_url: tab.favIconUrl || null
        });
        tab_ids_to_remove.push(tab.id);
      }

      if (tabs_to_save.length === 0) {
        alert('No saveable tabs found in this window.');
        save_tabs_button.disabled = false;
        save_tabs_button.textContent = 'Save All Tabs';
        return;
      }

      // build the tab data payload and encrypt it
      const tab_data = {
        date: new Date().toISOString(),
        tabs: tabs_to_save
      };

      const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
      const groups = await get_tab_groups(session_user);
      groups.unshift({
        id: Date.now().toString(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      });
      await save_tab_groups(session_user, groups);

      // open the manager page, then close the saved tabs
      const manager_tab = await chrome.tabs.create({ url: manager_url });
      const final_ids_to_remove = tab_ids_to_remove.filter(id => id !== manager_tab.id);
      if (final_ids_to_remove.length > 0) {
        await chrome.tabs.remove(final_ids_to_remove);
      }

      window.close();
    } catch (error) {
      alert(`Failed to save tabs: ${error.message}`);
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
        alert('Could not find the active tab.');
        save_current_tab_button.disabled = false;
        save_current_tab_button.textContent = 'Save This Tab';
        return;
      }

      const target_url = active_tab.url || active_tab.pendingUrl || '';
      if (!target_url ||
          target_url.startsWith('chrome://') ||
          target_url.startsWith('chrome-extension://') ||
          target_url.startsWith('about:')) {
        alert('This tab cannot be saved (system or internal page).');
        save_current_tab_button.disabled = false;
        save_current_tab_button.textContent = 'Save This Tab';
        return;
      }

      let title = active_tab.title;
      if (!title || title.trim() === '') {
        try { title = new URL(target_url).hostname; } catch (e) { title = 'Untitled'; }
      }

      const tab_data = {
        date: new Date().toISOString(),
        tabs: [{ title: title, url: target_url, fav_icon_url: active_tab.favIconUrl || null }]
      };

      const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
      const groups = await get_tab_groups(session_user);
      groups.unshift({
        id: Date.now().toString(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      });
      await save_tab_groups(session_user, groups);

      save_current_tab_button.textContent = 'Saved!';
      setTimeout(() => window.close(), 600);
    } catch (error) {
      alert(`Failed to save tab: ${error.message}`);
      save_current_tab_button.disabled = false;
      save_current_tab_button.textContent = 'Save This Tab';
    }
  });

  view_tabs_button.addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('manager_page/manager.html') });
      window.close();
    } catch (error) {
      alert(`Failed to open manager: ${error.message}`);
    }
  });
});

// evaluate password strength and return label, color, and percentage
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
