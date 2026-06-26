import {
  get_credentials, save_credentials, get_tab_groups,
  save_tab_groups, get_session_key, store_session_key
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

  const setup_password = document.getElementById('setup-password');
  const setup_password_confirm = document.getElementById('setup-password-confirm');
  const setup_button = document.getElementById('setup-button');

  const unlock_password = document.getElementById('unlock-password');
  const unlock_button = document.getElementById('unlock-button');

  const save_tabs_button = document.getElementById('save-tabs-button');
  const view_tabs_button = document.getElementById('view-tabs-button');

  const credentials = await get_credentials();

  if (!credentials) {
    // first run: show password setup
    setup_view.classList.remove('hidden');
    setTimeout(() => setup_password.focus(), 100);

    setup_password.addEventListener('keypress', (e) => { if (e.key === 'Enter') setup_password_confirm.focus(); });
    setup_password_confirm.addEventListener('keypress', (e) => { if (e.key === 'Enter') setup_button.click(); });

    setup_button.addEventListener('click', async () => {
      const password = setup_password.value;
      const confirm_password = setup_password_confirm.value;

      setup_error.classList.add('hidden');
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

        await save_credentials({
          password_salt: array_buffer_to_base64(salt),
          password_verifier: verifier
        });
        await store_session_key(key);

        locked_view.classList.add('hidden');
        unlocked_view.classList.remove('hidden');
      } catch (error) {
        setup_error.textContent = `Setup failed: ${error.message}`;
        setup_error.classList.remove('hidden');
        setup_button.disabled = false;
        setup_button.textContent = 'Create Password';
      }
    });
  } else {
    // returning user: try session key or prompt for password
    const session_key = await get_session_key();
    if (session_key) {
      locked_view.classList.add('hidden');
      unlocked_view.classList.remove('hidden');
    } else {
      unlock_view.classList.remove('hidden');
      setTimeout(() => unlock_password.focus(), 100);
      unlock_password.addEventListener('keypress', (e) => { if (e.key === 'Enter') unlock_button.click(); });

      unlock_button.addEventListener('click', async () => {
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
          const salt = base64_to_array_buffer(credentials.password_salt);
          const key = await derive_key_from_password(password, salt);
          const decrypted_verifier = await decrypt(credentials.password_verifier, key);

          if (decrypted_verifier === VERIFIER_STRING) {
            await store_session_key(key);
            locked_view.classList.add('hidden');
            unlocked_view.classList.remove('hidden');
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
  }

  // save all open tabs in the current window, encrypted
  save_tabs_button.addEventListener('click', async () => {
    const session_key = await get_session_key();
    if (!session_key) {
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
      const groups = await get_tab_groups();
      groups.unshift({
        id: Date.now().toString(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      });
      await save_tab_groups(groups);

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

  // save only the currently active tab, not all tabs in the window
  // useful when you just want to bookmark one tab into your encrypted store
  const save_current_tab_button = document.getElementById('save-current-tab-button');
  save_current_tab_button.addEventListener('click', async () => {
    const session_key = await get_session_key();
    if (!session_key) {
      locked_view.classList.remove('hidden');
      unlocked_view.classList.add('hidden');
      unlock_view.classList.remove('hidden');
      return;
    }

    save_current_tab_button.disabled = true;
    save_current_tab_button.textContent = 'Saving...';

    try {
      // query the single active tab in the current window
      const [active_tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active_tab) {
        alert('Could not find the active tab.');
        save_current_tab_button.disabled = false;
        save_current_tab_button.textContent = 'Save This Tab';
        return;
      }

      // fall back to pendingUrl if the tab is still loading
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
      const groups = await get_tab_groups();
      groups.unshift({
        id: Date.now().toString(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      });
      await save_tab_groups(groups);

      // brief visual feedback before closing
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
