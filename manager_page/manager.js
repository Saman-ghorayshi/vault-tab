import {
  get_all_users, get_user_by_username, save_user,
  get_tab_groups, save_tab_groups,
  get_session_key, store_session_key, clear_session_key,
  get_session_user, set_session_user,
  get_settings, save_settings, save_model, load_model
} from '../common/storage.js';
import {
  derive_key_from_password, decrypt, encrypt,
  base64_to_array_buffer,
  OLD_ITERATIONS, CURRENT_ITERATIONS
} from '../common/crypto.js';
import { is_restorable_url, get_url_status } from '../common/urls.js';
import { LocalTabEmbedder, calculate_cosine_similarity, kmeans_cluster } from '../common/embedder.js';

const VERIFIER_STRING = 'aegis-verification-string';

// the username that is currently unlocked in this session
let active_username = null;

// neural network embedder instance for semantic search and clustering
const embedder = new LocalTabEmbedder();

// state objects
const selection_state = {
  selected_tabs: new Set(),
  last_clicked_index: -1,
  current_group_id: null,
  focused_index: -1,
  all_tab_elements: []
};

const delete_state = {
  pending_deletions: [],
  toast_visible: false,
  timer_interval: null
};

const settings = { always_private: false, auto_lock_minutes: 0 };

// auto-lock: tracks last activity time and locks if idle too long
let auto_lock_timer = null;
let last_activity_time = Date.now();

function check_auto_lock() {
  if (settings.auto_lock_minutes <= 0) return;
  const ms = settings.auto_lock_minutes * 60 * 1000;
  const idle = Date.now() - last_activity_time;
  if (idle >= ms) {
    clear_session_key().then(() => location.reload());
  } else {
    auto_lock_timer = setTimeout(check_auto_lock, ms - idle + 1000);
  }
}

function reset_auto_lock_timer() {
  last_activity_time = Date.now();
  if (auto_lock_timer) clearTimeout(auto_lock_timer);
  if (settings.auto_lock_minutes <= 0) return;
  const ms = settings.auto_lock_minutes * 60 * 1000;
  auto_lock_timer = setTimeout(check_auto_lock, ms);
}

// tracks the currently dragged tab element for drag-and-drop reordering
const drag_state = {
  dragged_element: null,
  dragged_group_id: null
};

// semantic search reorders the dom for visual ranking.
// to keep the user's drag-and-drop order safe, we snapshot the original
// tab and group-card order before the first semantic reorder, and restore it
// when the search is cleared, the toggle is flipped off, or the page re-renders.
// order_saved is false when no snapshot is held.
const search_state = {
  order_saved: false,
  tab_order: [],   // array of { parentId, tabId }
  group_order: []   // array of groupIds in original container order
};

document.addEventListener('DOMContentLoaded', async () => {
  const loading_message = document.getElementById('loading-message');
  const password_prompt_view = document.getElementById('password-prompt-view');
  const groups_container = document.getElementById('groups-container');
  const manager_password = document.getElementById('manager-password');
  const manager_error = document.getElementById('manager-error');
  const manager_unlock_button = document.getElementById('manager-unlock-button');
  const import_button = document.getElementById('import-button');
  const import_file = document.getElementById('import-file');
  const paste_urls_button = document.getElementById('paste-urls-button');
  const always_private_toggle = document.getElementById('always-private-toggle');
  const lock_button = document.getElementById('lock-button');
  const search_input = document.getElementById('search-input');

  // password eye toggle on manager unlock page
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

  await load_settings();
  always_private_toggle.checked = settings.always_private;
  check_incognito_permission();

  always_private_toggle.addEventListener('change', (e) => {
    settings.always_private = e.target.checked;
    save_settings(settings);
  });

  // auto-lock setting
  const auto_lock_select = document.getElementById('auto-lock-select');
  if (auto_lock_select) {
    auto_lock_select.value = String(settings.auto_lock_minutes);
    auto_lock_select.addEventListener('change', (e) => {
      settings.auto_lock_minutes = parseInt(e.target.value, 10) || 0;
      save_settings(settings);
      if (settings.auto_lock_minutes > 0) {
        reset_auto_lock_timer();
      } else if (auto_lock_timer) {
        clearTimeout(auto_lock_timer);
      }
    });
  }

  document.getElementById('dismiss-warning')?.addEventListener('click', () => {
    document.getElementById('incognito-warning').classList.add('hidden');
  });

  import_button.addEventListener('click', () => import_file.click());

  import_file.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const urls = text.split('\n')
        .map(url => url.trim())
        .filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
      if (urls.length === 0) {
        alert('No valid URLs found.');
        return;
      }
      await save_urls_as_group(urls, 'Imported');
    } catch (error) {
      alert(`Failed to import URLs: ${error.message}`);
    }
    import_file.value = '';
  });

  // export all saved groups as a single encrypted .aegis backup file
  // the backup contains the raw encrypted groups and credentials salt
  // so it can be restored on any machine without re-encrypting
  const export_backup_button = document.getElementById('export-backup-button');
  if (export_backup_button) {
    export_backup_button.addEventListener('click', async () => {
      try {
        const groups = await get_tab_groups(active_username);
        if (groups.length === 0) {
          alert('No saved tabs to export.');
          return;
        }

        // include the user's credentials so the backup can be restored on
        // a fresh install without the original account existing yet.
        // salt and verifier are not secret — recovering the password from
        // them still requires brute-forcing through PBKDF2.
        const user = await get_user_by_username(active_username);

        // build the backup object with metadata and credentials
        const backup_data = {
          format: 'aegis-backup',
          version: 1,
          exported_at: new Date().toISOString(),
          exported_by: active_username,
          password_salt: user?.password_salt || null,
          password_verifier: user?.password_verifier || null,
          password_iterations: user?.password_iterations || null,
          group_count: groups.length,
          groups: groups
        };

        const json_string = JSON.stringify(backup_data, null, 2);
        const blob = new Blob([json_string], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aegis-backup-${new Date().toISOString().split('T')[0]}.aegis`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (error) {
        alert(`Failed to export backup: ${error.message}`);
      }
    });
  }

  // import a .aegis backup file and merge groups into storage
  const import_backup_button = document.getElementById('import-backup-button');
  const import_backup_file = document.getElementById('import-backup-file');
  if (import_backup_button && import_backup_file) {
    import_backup_button.addEventListener('click', () => import_backup_file.click());

    import_backup_file.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const backup_data = JSON.parse(text);

        if (!backup_data.format || backup_data.format !== 'aegis-backup') {
          alert('This is not a valid Aegis Tab backup file.');
          import_backup_file.value = '';
          return;
        }

        if (!backup_data.groups || !Array.isArray(backup_data.groups)) {
          alert('Backup file is corrupted or missing group data.');
          import_backup_file.value = '';
          return;
        }

        // determine which user the backup belongs to
        const backup_username = backup_data.exported_by || active_username;
        let import_target = backup_username;

        // if the backup user doesn't exist locally, create them from the
        // exported credentials so the original password can still unlock.
        if (backup_username !== active_username) {
          const existing = await get_user_by_username(backup_username);
          if (!existing) {
            if (!backup_data.password_salt || !backup_data.password_verifier) {
              alert('Backup file is missing credentials. Cannot restore this account.');
              import_backup_file.value = '';
              return;
            }
            const new_user = {
              username: backup_username,
              password_salt: backup_data.password_salt,
              password_verifier: backup_data.password_verifier,
              password_iterations: backup_data.password_iterations || null,
              tab_groups: []
            };
            await save_user(new_user);
            import_target = backup_username;
          }
        }

        // merge: load existing groups for the target user, then add backup groups
        // avoid duplicates by checking group ids
        const existing_groups = await get_tab_groups(import_target);
        const existing_ids = new Set(existing_groups.map(g => g.id));
        let added_count = 0;

        for (const group of backup_data.groups) {
          if (!existing_ids.has(group.id)) {
            existing_groups.unshift(group);
            added_count++;
          }
        }

        await save_tab_groups(import_target, existing_groups);
        alert(`Imported ${added_count} group(s) from backup.`);
        location.reload();
      } catch (error) {
        alert(`Failed to import backup: ${error.message}`);
      }
      import_backup_file.value = '';
    });
  }

  setup_paste_modal();
  paste_urls_button.addEventListener('click', open_paste_modal);
  setup_keyboard_shortcuts();

  // auto-lock: track mouse and keyboard activity, reset timer on each event
  if (settings.auto_lock_minutes > 0) {
    document.addEventListener('mousemove', reset_auto_lock_timer, { passive: true });
    document.addEventListener('keydown', reset_auto_lock_timer, { passive: true });
    document.addEventListener('click', reset_auto_lock_timer, { passive: true });
    reset_auto_lock_timer();
  }

  // neural network training button
  const train_model_button = document.getElementById('train-model-button');
  if (train_model_button) {
    train_model_button.addEventListener('click', () => start_neural_training());
  }

  // search filter (supports semantic mode)
  if (search_input) {
    search_input.addEventListener('input', () => {
      const semantic_toggle = document.getElementById('semantic-search-toggle');
      if (semantic_toggle && semantic_toggle.checked && embedder.is_trained) {
        semantic_search_tabs(search_input.value);
      } else {
        filter_tabs_by_search();
      }
    });
  }

  // flipping the semantic toggle should immediately re-run the search using the
  // new mode, otherwise a stale semantic reorder would linger until the user
  // types again. turning it off falls back to text search, which restores order.
  const semantic_search_toggle = document.getElementById('semantic-search-toggle');
  if (semantic_search_toggle) {
    semantic_search_toggle.addEventListener('change', () => {
      if (semantic_search_toggle.checked && embedder.is_trained && search_input) {
        semantic_search_tabs(search_input.value);
      } else if (search_input) {
        filter_tabs_by_search();
      }
    });
  }

  // lock button: clear session key, hide everything, show password prompt
  if (lock_button) {
    lock_button.addEventListener('click', async () => {
      await clear_session_key();
      selection_state.selected_tabs.clear();
      selection_state.all_tab_elements = [];

      // clear any semantic search order snapshot so the lock screen
      // does not hold stale dom references across a future render.
      search_state.order_saved = false;
      search_state.tab_order = [];
      search_state.group_order = [];

      // hide everything: groups, header, settings, action panel
      groups_container.innerHTML = '';
      groups_container.classList.add('hidden');
      document.getElementById('settings-panel')?.classList.add('hidden');
      document.querySelector('header')?.classList.add('hidden');
      document.getElementById('shortcuts-help')?.classList.add('hidden');
      document.getElementById('action-panel')?.classList.add('hidden');
      document.getElementById('analytics-panel')?.classList.add('hidden');

      // show password prompt
      loading_message.classList.add('hidden');
      password_prompt_view.classList.remove('hidden');
      setTimeout(() => manager_password.focus(), 100);
    });
  }

  // floating action panel buttons
  setup_action_panel();

  // shortcuts guide modal: click outside or close button to dismiss
  const shortcuts_modal = document.getElementById('shortcuts-modal');
  const close_shortcuts_btn = document.getElementById('close-shortcuts-modal');
  if (close_shortcuts_btn) {
    close_shortcuts_btn.addEventListener('click', () => {
      shortcuts_modal.classList.add('hidden');
    });
  }
  if (shortcuts_modal) {
    shortcuts_modal.addEventListener('click', (e) => {
      if (e.target === shortcuts_modal) shortcuts_modal.classList.add('hidden');
    });
  }

  const session_key = await get_session_key();
  const session_user = await get_session_user();
  if (session_key && session_user) {
    active_username = session_user;
    const user_label = document.getElementById('current-user-display');
    if (user_label) user_label.textContent = session_user;
    document.getElementById('analytics-panel')?.classList.remove('hidden');
    render_page(session_key);
  } else {
    // locked on initial load: hide everything except the password prompt
    loading_message.classList.add('hidden');
    document.getElementById('settings-panel')?.classList.add('hidden');
    document.querySelector('header')?.classList.add('hidden');
    document.getElementById('shortcuts-help')?.classList.add('hidden');
    password_prompt_view.classList.remove('hidden');

    // populate user dropdown for multi-user
    const all_users = await get_all_users();
    const manager_username_select = document.getElementById('manager-username-select');
    const manager_username_wrapper = document.getElementById('manager-username-wrapper');
    if (all_users.length > 1 && manager_username_select) {
      manager_username_wrapper?.classList.remove('hidden');
      all_users.forEach(u => {
        const option = document.createElement('option');
        option.value = u.username;
        option.textContent = u.username;
        manager_username_select.appendChild(option);
      });
    } else if (all_users.length === 1 && manager_username_select) {
      manager_username_select.value = all_users[0].username;
    }

    setTimeout(() => manager_password.focus(), 100);

    manager_password.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') manager_unlock_button.click();
    });

    manager_unlock_button.addEventListener('click', async () => {
      const password = manager_password.value;
      const username = all_users.length === 1
        ? all_users[0].username
        : manager_username_select?.value;
      manager_error.classList.add('hidden');
      if (!password) {
        manager_error.textContent = 'Please enter your password';
        manager_error.classList.remove('hidden');
        return;
      }
      if (!username) {
        manager_error.textContent = 'Please select a user';
        manager_error.classList.remove('hidden');
        return;
      }

      manager_unlock_button.disabled = true;
      manager_unlock_button.textContent = 'Unlocking...';

      try {
        const user = await get_user_by_username(username);
        if (!user) {
          // constant-time dummy derivation so a failed username lookup takes
          // roughly as long as a wrong-password attempt, preventing a timing
          // side-channel that leaks whether a username exists.
          const dummy_salt = new Uint8Array(16);
          await derive_key_from_password('dummy_placeholder', dummy_salt, OLD_ITERATIONS);
          throw new Error('User not found');
        }

        const salt = base64_to_array_buffer(user.password_salt);
        // use the stored iteration count, or fall back to old default if missing
        const stored_iterations = user.password_iterations || OLD_ITERATIONS;
        const key = await derive_key_from_password(password, salt, stored_iterations);
        const decrypted_verifier = await decrypt(user.password_verifier, key);

        if (decrypted_verifier === VERIFIER_STRING) {
          // silent upgrade: if the account was created with the old iteration
          // count, re-derive at the new count, re-encrypt the verifier, and save.
          if (stored_iterations < CURRENT_ITERATIONS) {
            try {
              const new_key = await derive_key_from_password(password, salt, CURRENT_ITERATIONS);
              const new_verifier = await encrypt(VERIFIER_STRING, new_key);
              user.password_verifier = new_verifier;
              user.password_iterations = CURRENT_ITERATIONS;
              await save_user(user);
              await store_session_key(new_key);
            } catch (_) {
              // upgrade failed — fall back to old key so session still works
              await store_session_key(key);
            }
          } else {
            await store_session_key(key);
          }
          await set_session_user(username);
          active_username = username;
          password_prompt_view.classList.add('hidden');
          // restore hidden ui elements after unlock
          document.querySelector('header')?.classList.remove('hidden');
          document.getElementById('settings-panel')?.classList.remove('hidden');
          document.getElementById('shortcuts-help')?.classList.remove('hidden');
          document.getElementById('analytics-panel')?.classList.remove('hidden');
          const user_label = document.getElementById('current-user-display');
          if (user_label) user_label.textContent = username;
          render_page(key);
        } else {
          throw new Error('Decryption failed');
        }
      } catch (error) {
        manager_error.textContent = 'Incorrect password';
        manager_error.classList.remove('hidden');
        manager_unlock_button.disabled = false;
        manager_unlock_button.textContent = 'Unlock';
      }
    });
  }
});

async function check_incognito_permission() {
  try {
    const is_allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!is_allowed) {
      document.getElementById('incognito-warning').classList.remove('hidden');
    }
  } catch (error) {
    // ignore
  }
}

async function load_settings() {
  try {
    const stored = await get_settings();
    settings.always_private = stored.always_private || false;
    settings.auto_lock_minutes = stored.auto_lock_minutes || 0;
  } catch (error) {
    // use defaults
  }
}

function setup_paste_modal() {
  const modal = document.getElementById('paste-modal');
  const close_btn = document.getElementById('close-paste-modal');
  const cancel_btn = document.getElementById('cancel-paste');
  const save_btn = document.getElementById('save-pasted-urls');
  const textarea = document.getElementById('paste-textarea');

  close_btn.addEventListener('click', close_paste_modal);
  cancel_btn.addEventListener('click', close_paste_modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) close_paste_modal(); });

  save_btn.addEventListener('click', async () => {
    const text = textarea.value;
    const url_regex = /https?:\/\/[^\s<>"']+/g;
    const matches = text.match(url_regex);
    if (!matches || matches.length === 0) {
      alert('No valid URLs found.');
      return;
    }
    const unique_urls = [...new Set(matches)];
    await save_urls_as_group(unique_urls, 'Pasted');
    close_paste_modal();
  });

  // enter to save urls from the paste modal textarea
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save_btn.click();
    }
  });

  // escape to close modal
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close_paste_modal();
    }
  });
}

function open_paste_modal() {
  document.getElementById('paste-modal').classList.remove('hidden');
  document.getElementById('paste-textarea').value = '';
  setTimeout(() => document.getElementById('paste-textarea').focus(), 100);
}

function close_paste_modal() {
  document.getElementById('paste-modal').classList.add('hidden');
}

async function save_urls_as_group(urls, prefix = 'Imported') {
  const session_key = await get_session_key();
  if (!session_key) {
    alert('Please unlock first.');
    return;
  }

  const tab_data = {
    date: new Date().toISOString(),
    tabs: urls.map(url => {
      // derive hostname for the display title, fall back to the raw url
      let hostname = url;
      try { hostname = new URL(url).hostname; } catch (e) {}
      // compute status so chrome:// and file:// get the right badge and
      // get filtered out of restore if the paste/import filter ever
      // lets them through
      return {
        id: crypto.randomUUID(),
        title: `${prefix}: ${hostname}`,
        url: url,
        fav_icon_url: null,
        status: get_url_status(url)
      };
    })
  };

  const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
  const new_group = {
    id: crypto.randomUUID(),
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext
  };
  const groups = await get_tab_groups(active_username);
  groups.unshift(new_group);
  await save_tab_groups(active_username, groups);
  location.reload();
}

function setup_action_panel() {
  const open_btn = document.getElementById('action-open-selected');
  const delete_btn = document.getElementById('action-delete-selected');
  const export_btn = document.getElementById('action-export-selected');
  const clear_btn = document.getElementById('action-clear-selection');

  if (clear_btn) {
    clear_btn.addEventListener('click', clear_selection);
  }

  if (delete_btn) {
    delete_btn.addEventListener('click', () => {
      delete_selected_items();
      update_action_panel();
    });
  }

  // open selected tabs in a new window
  if (open_btn) {
    open_btn.addEventListener('click', async () => {
      const selected = get_selected_tab_elements();
      const urls = [];
      selected.forEach(el => {
        const url = el.dataset.url;
        if (url) urls.push(url);
      });
      if (urls.length > 0) {
        await restore_tabs_batched(urls, settings.always_private);
      }
    });
  }

  // export selected tabs as a text file
  if (export_btn) {
    export_btn.addEventListener('click', () => {
      const selected = get_selected_tab_elements();
      const urls = [];
      selected.forEach(el => {
        const link = el.querySelector('.tab-link');
        if (link) {
          const href = link.getAttribute('href');
          if (href) urls.push(href);
        }
      });
      if (urls.length === 0) return;
      const urls_text = urls.join('\n');
      const blob = new Blob([urls_text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aegis-selected-${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // one permanent undo listener instead of cloning the button on every toast
  document.getElementById('undo-button')?.addEventListener('click', undo_all_deletions);
}

function setup_keyboard_shortcuts() {
  window.addEventListener('keydown', (e) => {
    // typing in inputs should not trigger shortcuts
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      // except Escape inside search to blur it
      if (e.key === 'Escape') {
        e.target.blur();
      }
      return;
    }

    // Delete or Backspace: delete selected tabs
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      delete_selected_items();
      update_action_panel();
    }

    // Ctrl+A: select all tabs in current group
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      select_all_in_current_group();
      update_action_panel();
    }

    // J: move focus down, K: move focus up (vim style)
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      move_focus(1);
    }
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      move_focus(-1);
    }

    // Enter: toggle selection on the focused tab
    if (e.key === 'Enter') {
      e.preventDefault();
      toggle_focused_selection();
      update_action_panel();
    }

    // Space: toggle selection on focused tab (gmail style alternative)
    if (e.key === ' ') {
      e.preventDefault();
      toggle_focused_selection();
      update_action_panel();
    }

    // X: toggle selection on focused tab without moving (gmail style)
    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      toggle_focused_selection();
      move_focus(1);
      update_action_panel();
    }

    // O: open selected tabs (or focused tab if none selected)
    if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      open_selected_or_focused();
    }

    // / (slash): focus the search bar
    if (e.key === '/') {
      e.preventDefault();
      const search_input = document.getElementById('search-input');
      if (search_input) search_input.focus();
    }

    // ?: open the shortcuts guide modal
    if (e.key === '?') {
      e.preventDefault();
      const modal = document.getElementById('shortcuts-modal');
      if (modal) modal.classList.remove('hidden');
    }

    // Escape: clear selection and close any open modal
    if (e.key === 'Escape') {
      const shortcuts_modal = document.getElementById('shortcuts-modal');
      if (shortcuts_modal && !shortcuts_modal.classList.contains('hidden')) {
        shortcuts_modal.classList.add('hidden');
      } else {
        clear_selection();
      }
    }
  });
}

// open selected tabs, or if nothing selected, open the focused tab
async function open_selected_or_focused() {
  const selected = get_selected_tab_elements();
  let urls = [];

  if (selected.length > 0) {
    selected.forEach(el => {
      const url = el.dataset.url;
      if (url) urls.push(url);
    });
  } else {
    // fallback: open the focused tab
    const tabs = selection_state.all_tab_elements;
    if (selection_state.focused_index >= 0 && tabs[selection_state.focused_index]) {
      const url = tabs[selection_state.focused_index].dataset.url;
      if (url) urls.push(url);
    }
  }

  if (urls.length > 0) {
    await restore_tabs_batched(urls, settings.always_private);
  }
}

function delete_selected_items() {
  if (selection_state.selected_tabs.size === 0) return;
  selection_state.selected_tabs.forEach((tab) => {
    soft_delete_tab(tab, tab.dataset.groupId, tab.dataset.tabId);
  });
}

function select_all_in_current_group() {
  let target_group = selection_state.current_group_id
    ? document.querySelector(`[data-group-id="${selection_state.current_group_id}"]`)
    : document.querySelector('.group-card');
  if (target_group) {
    target_group.querySelectorAll('.tab-item').forEach(tab => {
      selection_state.selected_tabs.add(tab);
      tab.classList.add('selected');
    });
    selection_state.current_group_id = target_group.dataset.groupId;
  }
}

function move_focus(direction) {
  const tabs = selection_state.all_tab_elements;
  if (tabs.length === 0) return;
  if (selection_state.focused_index >= 0 && tabs[selection_state.focused_index]) {
    tabs[selection_state.focused_index].classList.remove('focused');
  }

  let new_index = Math.max(0, Math.min(selection_state.focused_index + direction, tabs.length - 1));
  selection_state.focused_index = new_index;

  if (tabs[new_index]) {
    tabs[new_index].classList.add('focused');
    tabs[new_index].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    selection_state.current_group_id = tabs[new_index].dataset.groupId;
  }
}

function toggle_focused_selection() {
  const tabs = selection_state.all_tab_elements;
  if (selection_state.focused_index >= 0 && tabs[selection_state.focused_index]) {
    const tab = tabs[selection_state.focused_index];
    if (selection_state.selected_tabs.has(tab)) {
      selection_state.selected_tabs.delete(tab);
      tab.classList.remove('selected');
    } else {
      selection_state.selected_tabs.add(tab);
      tab.classList.add('selected');
    }
  }
}

function clear_selection() {
  selection_state.selected_tabs.forEach(tab => tab.classList.remove('selected'));
  selection_state.selected_tabs.clear();
  selection_state.last_clicked_index = -1;
  update_action_panel();
}

// update the floating action panel visibility and count
function update_action_panel() {
  const panel = document.getElementById('action-panel');
  const count_span = document.getElementById('action-panel-count');
  if (!panel || !count_span) return;

  const count = selection_state.selected_tabs.size;
  if (count > 0) {
    count_span.textContent = count === 1 ? '1 selected' : `${count} selected`;
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

// get the selected tab elements as an array in dom order
function get_selected_tab_elements() {
  return selection_state.all_tab_elements.filter(el => selection_state.selected_tabs.has(el));
}

function handle_tab_click(e, tab_element, tab_index, group_id) {
  if (e.target.classList.contains('tab-delete-button')) return;
  if (e.target.classList.contains('tab-link')) return; // Let the <a> tag open the link naturally
  e.preventDefault();
  const all_tabs = selection_state.all_tab_elements;
  const global_index = all_tabs.indexOf(tab_element);
  selection_state.current_group_id = group_id;

  if (e.shiftKey && selection_state.last_clicked_index >= 0) {
    const start = Math.min(selection_state.last_clicked_index, global_index);
    const end = Math.max(selection_state.last_clicked_index, global_index);
    for (let i = start; i <= end; i++) {
      if (all_tabs[i] && all_tabs[i].dataset.groupId === group_id) {
        selection_state.selected_tabs.add(all_tabs[i]);
        all_tabs[i].classList.add('selected');
      }
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (selection_state.selected_tabs.has(tab_element)) {
      selection_state.selected_tabs.delete(tab_element);
      tab_element.classList.remove('selected');
    } else {
      selection_state.selected_tabs.add(tab_element);
      tab_element.classList.add('selected');
    }
  } else {
    clear_selection();
    selection_state.selected_tabs.add(tab_element);
    tab_element.classList.add('selected');
  }
  selection_state.last_clicked_index = global_index;
  update_action_panel();
}

function soft_delete_tab(tab_element, group_id, tab_id) {
  tab_element.classList.add('fade-out');
  const deletion = {
    type: 'tab',
    element: tab_element,
    group_id: group_id,
    tab_id: tab_id,
    timeout_id: null
  };
  const existing_index = delete_state.pending_deletions.findIndex(d => d.element === tab_element);
  if (existing_index >= 0) {
    clearTimeout(delete_state.pending_deletions[existing_index].timeout_id);
    delete_state.pending_deletions.splice(existing_index, 1);
  }
  deletion.timeout_id = setTimeout(() => commit_deletion(deletion), 8000);
  delete_state.pending_deletions.push(deletion);
  show_undo_toast();
}

function soft_delete_group(group_element, group_id) {
  group_element.classList.add('fade-out');
  const deletion = {
    type: 'group',
    element: group_element,
    group_id: group_id,
    timeout_id: null
  };
  deletion.timeout_id = setTimeout(() => commit_deletion(deletion), 8000);
  delete_state.pending_deletions.push(deletion);
  show_undo_toast();
}

// remove an element from selection_state tracking after a real (non-undone)
// delete, so keyboard navigation and the floating action panel don't reference
// detached DOM nodes or show a stale selection count.
function cleanup_selection_for_tab(element) {
  selection_state.selected_tabs.delete(element);
  const idx = selection_state.all_tab_elements.indexOf(element);
  if (idx >= 0) selection_state.all_tab_elements.splice(idx, 1);
  update_action_panel();
}

async function commit_deletion(deletion) {
  try {
    const session_key = await get_session_key();

    // group deletion is just a filter on the envelope list -- it does not
    // touch any other group's ciphertext, so a concurrent reorder or import
    // is preserved automatically by reading fresh right before save.
    if (deletion.type === 'group') {
      const fresh_groups = await get_tab_groups(active_username);
      const updated_groups = fresh_groups.filter(g => g.id !== deletion.group_id);
      await save_tab_groups(active_username, updated_groups);
      cleanup_selection_for_tab(deletion.element);
      deletion.element.remove();
      if (updated_groups.length === 0) {
        document.getElementById('groups-container').innerHTML =
          '<div class="empty-state"><p>No saved tabs found.</p></div>';
      }
    } else if (deletion.type === 'tab') {
      // if the session was locked during the 8s undo window we can no longer
      // decrypt, and we must not silently drop the DOM element while leaving
      // the tab in storage (that was the old zombie-tab bug). undo the soft
      // delete visually so the user can re-delete after unlocking.
      if (!session_key) {
        deletion.element.classList.remove('fade-out');
        const rm_idx = delete_state.pending_deletions.indexOf(deletion);
        if (rm_idx >= 0) delete_state.pending_deletions.splice(rm_idx, 1);
        if (delete_state.pending_deletions.length === 0) hide_undo_toast();
        return;
      }

      // read the group fresh. decrypt/modify/re-encrypt only that one envelope
      // so any reorder or import that landed in between is not clobbered.
      let groups = await get_tab_groups(active_username);
      const group_index = groups.findIndex(g => g.id === deletion.group_id);
      if (group_index === -1) {
        // group was removed in the meantime, nothing to commit
        cleanup_selection_for_tab(deletion.element);
        deletion.element.remove();
        const rm_idx = delete_state.pending_deletions.indexOf(deletion);
        if (rm_idx >= 0) delete_state.pending_deletions.splice(rm_idx, 1);
        if (delete_state.pending_deletions.length === 0) hide_undo_toast();
        return;
      }

      const group_data = JSON.parse(await decrypt(groups[group_index], session_key));
      const tab_del_idx = group_data.tabs.findIndex(t => t.id === deletion.tab_id);
      if (tab_del_idx === -1) {
        cleanup_selection_for_tab(deletion.element);
        deletion.element.remove();
        const rm_idx = delete_state.pending_deletions.indexOf(deletion);
        if (rm_idx >= 0) delete_state.pending_deletions.splice(rm_idx, 1);
        if (delete_state.pending_deletions.length === 0) hide_undo_toast();
        return;
      }

      group_data.tabs.splice(tab_del_idx, 1);
      const group_now_empty = group_data.tabs.length === 0;

      if (group_now_empty) {
        // re-read the envelope list fresh again, then drop this group by id.
        // avoids overwriting a concurrent reorder or save that landed while
        // we were decrypting above.
        groups = await get_tab_groups(active_username);
        const without_group = groups.filter(g => g.id !== deletion.group_id);
        await save_tab_groups(active_username, without_group);
        const group_card = deletion.element.closest('.group-card');
        if (group_card) cleanup_selection_for_tab(group_card);
        group_card?.remove();
        if (without_group.length === 0) {
          document.getElementById('groups-container').innerHTML =
            '<div class="empty-state"><p>No saved tabs found.</p></div>';
        }
      } else {
        const encrypted = await encrypt(JSON.stringify(group_data), session_key);
        // re-read the envelope list fresh again so the order/import changes
        // that happened during encrypt() survive the write.
        groups = await get_tab_groups(active_username);
        const idx = groups.findIndex(g => g.id === deletion.group_id);
        if (idx === -1) {
          // group got removed while we were re-encrypting. drop so we don't
          // resurrect a deleted group.
          cleanup_selection_for_tab(deletion.element);
          deletion.element.remove();
        } else {
          groups[idx] = {
            id: deletion.group_id,
            iv: encrypted.iv,
            ciphertext: encrypted.ciphertext
          };
          await save_tab_groups(active_username, groups);
          cleanup_selection_for_tab(deletion.element);
          deletion.element.remove();
        }
      }
    }

    const index = delete_state.pending_deletions.indexOf(deletion);
    if (index >= 0) delete_state.pending_deletions.splice(index, 1);
    if (delete_state.pending_deletions.length === 0) hide_undo_toast();
  } catch (error) {
    // deletion failed -- keep the element visible so the user sees it
    // is still there instead of silently vanishing from storage
  }
}

function undo_all_deletions() {
  delete_state.pending_deletions.forEach(deletion => {
    clearTimeout(deletion.timeout_id);
    deletion.element.classList.remove('fade-out');
    if (deletion.type === 'tab') selection_state.selected_tabs.delete(deletion.element);
  });
  delete_state.pending_deletions = [];
  hide_undo_toast();
}

function show_undo_toast() {
  const toast = document.getElementById('undo-toast');
  const timer_span = document.getElementById('toast-timer');
  const message_span = document.getElementById('toast-message');
  const progress_bar = document.getElementById('toast-progress');
  const count = delete_state.pending_deletions.length;

  // smart messaging: distinguish tabs vs groups vs mixed
  let tab_count = 0;
  let group_count = 0;
  delete_state.pending_deletions.forEach(d => {
    if (d.type === 'group') group_count++;
    else tab_count++;
  });

  if (group_count > 0 && tab_count > 0) {
    message_span.textContent = `${count} items deleted`;
  } else if (group_count > 0) {
    message_span.textContent = group_count === 1 ? 'Group deleted' : `${group_count} groups deleted`;
  } else {
    message_span.textContent = tab_count === 1 ? 'Tab deleted' : `${tab_count} tabs deleted`;
  }

  toast.classList.remove('hidden');

  // restart the progress bar animation
  if (progress_bar) {
    progress_bar.style.animation = 'none';
    void progress_bar.offsetWidth; // force reflow
    progress_bar.style.animation = 'toast-progress 8s linear forwards';
  }

  let seconds_left = 8;
  timer_span.textContent = `${seconds_left}s`;
  if (delete_state.timer_interval) clearInterval(delete_state.timer_interval);
  delete_state.timer_interval = setInterval(() => {
    seconds_left--;
    if (seconds_left <= 0) {
      clearInterval(delete_state.timer_interval);
      hide_undo_toast();
    } else {
      timer_span.textContent = `${seconds_left}s`;
    }
  }, 1000);
}

function hide_undo_toast() {
  document.getElementById('undo-toast').classList.add('hidden');
  if (delete_state.timer_interval) clearInterval(delete_state.timer_interval);
}

// restore tabs in batches to avoid overwhelming the browser
async function restore_tabs_batched(urls, incognito = false) {
  // filter out URLs that Chrome will reject
  const safe_urls = urls.filter(is_restorable_url);
  if (safe_urls.length === 0) {
    alert('No restorable URLs in this group (all are system or internal pages).');
    return;
  }

  try {
    if (incognito) {
      const is_allowed = await chrome.extension.isAllowedIncognitoAccess();
      if (!is_allowed) {
        alert('Private browsing access is not enabled. Please enable "Allow in Incognito" in Chrome extension settings.');
        return;
      }
    }

    // create window with the first url
    const new_window = await chrome.windows.create({
      url: safe_urls[0],
      incognito: incognito
    });

    // batch the remaining urls
    const remaining_urls = safe_urls.slice(1);
    const batch_size = 10;

    for (let i = 0; i < remaining_urls.length; i += batch_size) {
      const batch = remaining_urls.slice(i, i + batch_size);
      const create_promises = batch.map(url =>
        chrome.tabs.create({
          windowId: new_window.id,
          url: url,
          active: false
        }).catch(err => {
          console.warn(`Failed to restore tab: ${url}`, err);
          return null;
        })
      );
      await Promise.all(create_promises);
    }
  } catch (error) {
    console.error('Error in batched restore:', error);
    alert(`Failed to restore some tabs: ${error.message}`);
  }
}

// render the page: decrypt all groups in parallel using Promise.all
async function render_page(key) {
  const loading_message = document.getElementById('loading-message');
  const groups_container = document.getElementById('groups-container');
  loading_message.classList.remove('hidden');
  groups_container.classList.add('hidden');

  try {
    groups_container.innerHTML = '';
    selection_state.all_tab_elements = [];

    // discard any semantic search order snapshot — the old dom nodes
    // are being destroyed by the innerHTML clear above.
    search_state.order_saved = false;
    search_state.tab_order = [];
    search_state.group_order = [];

    const encrypted_groups = await get_tab_groups(active_username);

    if (encrypted_groups.length === 0) {
      groups_container.innerHTML = '<div class="empty-state"><p>No saved tabs found.</p></div>';
      loading_message.classList.add('hidden');
      groups_container.classList.remove('hidden');
      return;
    }

    // decrypt all groups in parallel for speed
    // groups that fail to decrypt are kept as error entries so we can render
    // a diagnostic card instead of silently dropping them (bug 1.5)
    const decrypt_promises = encrypted_groups.map(group =>
      decrypt(group, key).then(plaintext => ({
        id: group.id,
        data: JSON.parse(plaintext),
        error: null
      })).catch(() => ({ id: group.id, data: null, error: true }))
    );

    const decrypted_results = await Promise.all(decrypt_promises);

    // backfill stable tab IDs for legacy data that lacks them
    const groups_needing_resave = new Set();
    for (let i = 0; i < decrypted_results.length; i++) {
      const result = decrypted_results[i];
      if (result.error) continue;
      for (const tab of result.data.tabs) {
        if (!tab.id) {
          tab.id = crypto.randomUUID();
          groups_needing_resave.add(i);
        }
      }
    }
    if (groups_needing_resave.size > 0) {
      try {
        // re-read the envelope list fresh so any concurrent reorder or
        // import that happened during decrypting doesn't get clobbered.
        const fresh_groups = await get_tab_groups(active_username);
        const updated_groups = fresh_groups.slice();
        for (const idx of groups_needing_resave) {
          const r = decrypted_results[idx];
          // the group index might have shifted in the fresh array; re-locate by id
          const fresh_idx = updated_groups.findIndex(g => g.id === r.id);
          if (fresh_idx === -1) continue; // group was removed, skip
          const re_enc = await encrypt(JSON.stringify(r.data), key);
          updated_groups[fresh_idx] = { id: r.id, iv: re_enc.iv, ciphertext: re_enc.ciphertext };
        }
        await save_tab_groups(active_username, updated_groups);
      } catch (_) {
        // backfill persist failed; IDs still in memory for this session
      }
    }

    // render groups in original order
    let group_index = 0;
    for (const result of decrypted_results) {
      if (result.error) {
        groups_container.appendChild(create_corrupted_group_element(result.id));
        continue;
      }
      groups_container.appendChild(
        create_group_element(result.id, result.data, group_index)
      );
      group_index++;
    }

    loading_message.classList.add('hidden');
    groups_container.classList.remove('hidden');

    // load the saved neural network model if it exists
    load_saved_model();
  } catch (error) {
    loading_message.innerHTML = '<p class="error">Error loading saved tabs</p>';
  }
}

function create_group_element(group_id, group_data, group_index = 0) {
  const group_element = document.createElement('div');
  group_element.className = 'group-card';
  group_element.dataset.groupId = group_id;
  group_element.style.animationDelay = `${Math.min(group_index * 0.05, 0.4)}s`; 

  const date = new Date(group_data.date);
  const formatted_date = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

  const header = document.createElement('div');
  header.className = 'group-header';
  const display_name = group_data.name || `Saved on ${formatted_date}`;

  const title_el = document.createElement('h3');
  title_el.className = 'group-title';
  title_el.title = 'Double-click to rename';
  title_el.textContent = `${display_name} (${group_data.tabs.length} tabs)`;

  const actions_div = document.createElement('div');
  actions_div.className = 'group-actions';
  actions_div.innerHTML =
    '<button class="restore-button secondary-button">Restore All</button>' +
    '<button class="restore-private-button private-restore-button">Incognito</button>' + // Clearer intent
    '<button class="export-urls-button secondary-button">Export URLs</button>' +
    '<button class="delete-button">Delete Group</button>'; // Clearer intent

  header.appendChild(title_el);
  header.appendChild(actions_div);

  // double-click the title to rename the session
  title_el.addEventListener('dblclick', () => {
    const new_name = prompt('Rename this session:', display_name);
    if (new_name && new_name.trim()) {
      rename_session(group_id, new_name.trim(), title_el);
    }
  });

  const tabs_list = document.createElement('div');
  tabs_list.className = 'tabs-list';
  // a stable, group-scoped id so semantic search can snapshot and restore
  // the original tab order without holding dom references across calls.
  tabs_list.id = `tabs-list-${group_id}`;

  group_data.tabs.forEach((tab, tab_index) => {
    const tab_element = document.createElement('div');
    tab_element.className = 'tab-item';
    tab_element.dataset.groupId = group_id;
    tab_element.dataset.tabId = tab.id || '';
    tab_element.dataset.url = tab.url || '';
    tab_element.draggable = true;

    if (tab.fav_icon_url) {
      const fav_img = document.createElement('img');
      fav_img.src = tab.fav_icon_url;
      fav_img.alt = 'favicon';
      fav_img.className = 'favicon';
      fav_img.onerror = function () { this.style.display = 'none'; };
      tab_element.appendChild(fav_img);
    } else {
      const fav_placeholder = document.createElement('div');
      fav_placeholder.className = 'favicon-placeholder';
      tab_element.appendChild(fav_placeholder);
    }

    // render the tab title: clickable link for normal tabs, plain text for unsaveable
    const is_unsaveable = tab.status === 'unsaveable';
    if (is_unsaveable) {
      const span_el = document.createElement('span');
      span_el.className = 'tab-link tab-link-disabled';
      span_el.textContent = tab.title;
      tab_element.appendChild(span_el);

      const badge = document.createElement('span');
      badge.className = 'tab-status-badge tab-status-system';
      badge.textContent = 'system';
      tab_element.appendChild(badge);
    } else {
      const link_el = document.createElement('a');
      link_el.href = tab.url;
      link_el.target = '_blank';
      link_el.className = 'tab-link';
      link_el.textContent = tab.title;
      tab_element.appendChild(link_el);

      if (tab.status === 'local_file') {
        const badge = document.createElement('span');
        badge.className = 'tab-status-badge tab-status-local';
        badge.textContent = 'local';
        tab_element.appendChild(badge);
      }
    }

    const del_btn = document.createElement('button');
    del_btn.className = 'tab-delete-button';
    del_btn.innerHTML = '&times;'; // A much cleaner, larger standard HTML X icon
    del_btn.title = "Delete this tab";
    tab_element.appendChild(del_btn);

    tab_element.addEventListener('click', (e) => handle_tab_click(e, tab_element, tab_index, group_id));
    del_btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      soft_delete_tab(tab_element, group_id, tab.id);
    });

    // drag-and-drop reordering within the same group
    // stores a reference to the dragged element, then on drop reorders
    // the dom and persists the new order to encrypted storage
    tab_element.addEventListener('dragstart', (e) => {
      // if semantic search has reordered the dom, drop the snapshot first so
      // the user drags from their real order, not the visual ranking. this
      // prevents the persisted reorder from clobbering the user's order with
      // semantic-search positions.
      restore_search_order();
      tab_element.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', group_id);
      drag_state.dragged_element = tab_element;
      drag_state.dragged_group_id = group_id;
    });

    tab_element.addEventListener('dragend', () => {
      tab_element.classList.remove('dragging');
      drag_state.dragged_element = null;
      drag_state.dragged_group_id = null;
      // clear visual markers on all tabs
      document.querySelectorAll('.tab-item').forEach(el => el.classList.remove('drag-over'));
    });

    tab_element.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (drag_state.dragged_element && drag_state.dragged_group_id === group_id) {
        tab_element.classList.add('drag-over');
      }
    });

    tab_element.addEventListener('dragleave', () => {
      tab_element.classList.remove('drag-over');
    });

    tab_element.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      tab_element.classList.remove('drag-over');
      if (!drag_state.dragged_element || drag_state.dragged_group_id !== group_id) return;
      if (drag_state.dragged_element === tab_element) return;

      // reorder in the dom first for immediate visual feedback
      const tabs_list_el = tab_element.parentElement;
      const dragged = drag_state.dragged_element;
      const all_items = [...tabs_list_el.querySelectorAll('.tab-item')];
      const from_index = all_items.indexOf(dragged);
      const to_index = all_items.indexOf(tab_element);

      if (from_index < to_index) {
        tabs_list_el.insertBefore(dragged, tab_element.nextSibling);
      } else {
        tabs_list_el.insertBefore(dragged, tab_element);
      }

      // persist the new order to storage
      persist_tab_reorder(group_id, tabs_list_el);
    });

    tabs_list.appendChild(tab_element);
    selection_state.all_tab_elements.push(tab_element);
  });

  group_element.appendChild(header);
  group_element.appendChild(tabs_list);

  group_element.querySelector('.restore-button').addEventListener('click', async () => {
    const urls = group_data.tabs.map(tab => tab.url);
    await restore_tabs_batched(urls, settings.always_private);
  });

  group_element.querySelector('.restore-private-button').addEventListener('click', async () => {
    const urls = group_data.tabs.map(tab => tab.url);
    await restore_tabs_batched(urls, true);
  });

  group_element.querySelector('.export-urls-button').addEventListener('click', () => {
    const urls_text = group_data.tabs.map(tab => tab.url).join('\n');
    const blob = new Blob([urls_text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aegis-tab-urls-${new Date(group_data.date).toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  group_element.querySelector('.delete-button').addEventListener('click', () => {
    soft_delete_group(group_element, group_id);
  });

  return group_element;
}

// render a diagnostic card for a group whose ciphertext could not be decrypted.
// shows the raw group id, a warning message, and a delete button — the only
// useful action for ciphertext that can never be decrypted.
function create_corrupted_group_element(group_id) {
  const group_element = document.createElement('div');
  group_element.className = 'group-card group-card-corrupted';
  group_element.dataset.groupId = group_id;

  const header = document.createElement('div');
  header.className = 'group-header';

  const title_el = document.createElement('h3');
  title_el.className = 'group-title group-title-corrupted';
  title_el.textContent = '⚠ Could not read this saved group';

  const subtitle = document.createElement('p');
  subtitle.className = 'corrupted-subtitle';
  subtitle.textContent = `The encrypted data for this group (id: ${group_id.slice(0, 8)}…) could not be decrypted. It may be corrupted.`;

  const actions_div = document.createElement('div');
  actions_div.className = 'group-actions';
  const delete_btn = document.createElement('button');
  delete_btn.className = 'delete-button';
  delete_btn.textContent = 'Delete Group';
  delete_btn.addEventListener('click', () => {
    soft_delete_group(group_element, group_id);
  });
  actions_div.appendChild(delete_btn);

  header.appendChild(title_el);
  header.appendChild(subtitle);
  header.appendChild(actions_div);

  group_element.appendChild(header);
  return group_element;
}

// restore the original dom order of tabs and group cards that semantic search
// may have shuffled. only runs if a snapshot was saved. clears the snapshot after
// restoring so a subsequent semantic search starts fresh. also clears any
// similarity tooltips semantic search wrote onto tabs.
function restore_search_order() {
  if (!search_state.order_saved) return;

  // put each tab back into the order and parent it was in before the reorder.
  // rebuilding from the snapshot rather than sorting avoids depending on any
  // state the reorder may have left behind.
  for (const entry of search_state.tab_order) {
    const parent = document.getElementById(entry.parent_id);
    const tab = parent?.querySelector(`.tab-item[data-tab-id="${entry.tab_id}"]`);
    if (tab) parent.appendChild(tab);
  }

  // put group cards back into the container in their original order.
  const container = document.getElementById('groups-container');
  if (container) {
    for (const gid of search_state.group_order) {
      const card = container.querySelector(`.group-card[data-group-id="${gid}"]`);
      if (card) container.appendChild(card);
    }
  }

  // clear similarity tooltips semantic search may have written.
  document.querySelectorAll('.tab-item').forEach(el => {
    if (el.title && el.title.startsWith('Similarity:')) el.removeAttribute('title');
  });

  search_state.order_saved = false;
  search_state.tab_order = [];
  search_state.group_order = [];
}

// filter visible tabs based on search input
function filter_tabs_by_search() {
  // semantic search shuffles the dom; restoring first keeps the user's real
  // order intact whenever we fall back to plain text filtering (cleared query
  // or toggle flipped off).
  restore_search_order();

  const search_input = document.getElementById('search-input');
  if (!search_input) return;
  const query = search_input.value.toLowerCase().trim();

  const all_tab_items = document.querySelectorAll('.tab-item');
  let visible_count = 0;

  all_tab_items.forEach(tab_item => {
    const tab_link = tab_item.querySelector('.tab-link');
    if (!tab_link) return;
    const title_text = tab_link.textContent.toLowerCase();
    const url_text = (tab_item.dataset.url || '').toLowerCase();
    const matches = title_text.includes(query) || url_text.includes(query);
    tab_item.style.display = matches ? '' : 'none';
    if (matches) visible_count++;
  });

  // hide group cards that have no visible tabs
  document.querySelectorAll('.group-card').forEach(card => {
    const visible_tabs = card.querySelectorAll('.tab-item:not([style*="display: none"])');
    card.style.display = visible_tabs.length > 0 ? '' : 'none';
  });
}

// persist the new tab order after a drag-and-drop reorder
// reads the current dom order of tab elements, maps them back to tab data,
// re-encrypts, and saves. this is async and does not reload the page.
async function persist_tab_reorder(group_id, tabs_list_element) {
  try {
    const session_key = await get_session_key();
    if (!session_key) return;

    // read the group fresh
    let groups = await get_tab_groups(active_username);
    const group_index = groups.findIndex(g => g.id === group_id);
    if (group_index === -1) return;

    const group_data = JSON.parse(await decrypt(groups[group_index], session_key));
    const tab_elements = tabs_list_element.querySelectorAll('.tab-item');
    const reordered_tabs = [];

    // match dom elements to tab data by stable ID
    tab_elements.forEach(el => {
      const tid = el.dataset.tabId;
      if (tid) {
        const match = group_data.tabs.find(t => t.id === tid);
        if (match) reordered_tabs.push(match);
      }
    });

    if (reordered_tabs.length !== group_data.tabs.length) return;

    group_data.tabs = reordered_tabs;
    const encrypted = await encrypt(JSON.stringify(group_data), session_key);

    // re-read the envelope list fresh before writing so any concurrent
    // reorder or import that happened during encryption survives.
    groups = await get_tab_groups(active_username);
    const idx = groups.findIndex(g => g.id === group_id);
    if (idx === -1) return; // group was removed in the meantime, abort
    groups[idx] = {
      id: group_id,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext
    };
    await save_tab_groups(active_username, groups);


    // rebuild the all_tab_elements array for keyboard navigation
    selection_state.all_tab_elements = [...document.querySelectorAll('.tab-item')];
  } catch (error) {
    // reorder failed to persist, but the dom is already updated
    // a page reload will revert to the stored order
  }
}

// rename a saved session by updating the name field in the encrypted group data
async function rename_session(group_id, new_name, title_el) {
  try {
    const session_key = await get_session_key();
    if (!session_key) return;

    // read the group fresh
    let groups = await get_tab_groups(active_username);
    const group_index = groups.findIndex(g => g.id === group_id);
    if (group_index === -1) return;

    const group_data = JSON.parse(await decrypt(groups[group_index], session_key));
    group_data.name = new_name;
    const encrypted = await encrypt(JSON.stringify(group_data), session_key);

    // re-read the envelope list fresh before writing so a concurrent
    // reorder or import doesn't get silently overwritten.
    groups = await get_tab_groups(active_username);
    const idx = groups.findIndex(g => g.id === group_id);
    if (idx === -1) return; // group was removed in the meantime, abort
    groups[idx] = {
      id: group_id,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext
    };
    await save_tab_groups(active_username, groups);

    // update the title in the dom without reloading
    const tab_count = group_data.tabs.length;
    title_el.textContent = `${new_name} (${tab_count} tabs)`;
  } catch (error) {
    alert('Failed to rename session.');
  }
}

// --- neural network training and analytics ---

// load a previously trained model from storage and apply clustering
async function load_saved_model() {
  try {
    const saved = await load_model(active_username, await get_session_key());
    if (!saved) return;

    embedder.deserialize(saved);

    if (embedder.is_trained) {
      const status_el = document.getElementById('model-status');
      const vocab_display = document.getElementById('vocab-size-display');
      const train_button = document.getElementById('train-model-button');
      const loss_chart = document.getElementById('loss-chart');

      if (status_el) {
        status_el.textContent = 'Trained (loaded)';
        status_el.classList.add('trained');
      }
      if (vocab_display) vocab_display.textContent = `Vocab: ${embedder.vocab_size}`;
      if (train_button) train_button.textContent = 'Retrain';
      if (loss_chart && embedder.loss_history.length > 0) {
        update_loss_chart(loss_chart, embedder.loss_history);
      }

      // apply clustering with the loaded model
      const session_key = await get_session_key();
      if (session_key) {
        const encrypted_groups = await get_tab_groups(active_username);
        const decrypted_groups = [];
        for (const group of encrypted_groups) {
          try {
            const data = JSON.parse(await decrypt(group, session_key));
            decrypted_groups.push(data);
          } catch (e) {}
        }
        apply_clustering_to_tabs(decrypted_groups);
      }
    }
  } catch (error) {
    // model load failed, not critical
  }
}

// start training the embedding model on all decrypted tab data
async function start_neural_training() {
  const train_button = document.getElementById('train-model-button');
  const status_el = document.getElementById('model-status');
  const vocab_display = document.getElementById('vocab-size-display');
  const loss_display = document.getElementById('loss-display');
  const epoch_display = document.getElementById('epoch-display');
  const loss_chart = document.getElementById('loss-chart');

  if (train_button) {
    train_button.disabled = true;
    train_button.textContent = 'Training...';
  }
  if (status_el) {
    status_el.textContent = 'Training in progress...';
    status_el.classList.remove('trained');
  }
  if (loss_chart) {
    loss_chart.innerHTML = '<div class="loss-chart-empty">Training...</div>';
  }

  try {
    // decrypt all groups to get raw tab data for training
    const session_key = await get_session_key();
    if (!session_key) {
      // session was locked between the click and the await. reset the ui so
      // the train button does not get stuck disabled with 'Training...' text.
      if (status_el) status_el.textContent = 'Locked';
      if (train_button) { train_button.disabled = false; train_button.textContent = 'Train Model'; }
      return;
    }

    const encrypted_groups = await get_tab_groups(active_username);
    const decrypted_groups = [];

    for (const group of encrypted_groups) {
      try {
        const data = JSON.parse(await decrypt(group, session_key));
        decrypted_groups.push(data);
      } catch (e) {
        // skip groups that fail to decrypt
      }
    }

    if (decrypted_groups.length === 0) {
      if (status_el) status_el.textContent = 'No tab data to train on';
      if (train_button) { train_button.disabled = false; train_button.textContent = 'Train Model'; }
      return;
    }

    // build the training dataset
    const dataset = embedder.create_training_dataset(decrypted_groups);

    if (dataset.length === 0) {
      if (status_el) status_el.textContent = 'No tokens found in tab data';
      if (train_button) { train_button.disabled = false; train_button.textContent = 'Train Model'; }
      return;
    }

    if (vocab_display) vocab_display.textContent = `Vocab: ${embedder.vocab_size}`;

    // run training with chunked execution
    const epochs = 20;
    const learning_rate = 0.05;

    embedder.train_epochs(dataset, epochs, learning_rate,
      (progress) => {
        if (loss_display) loss_display.textContent = `Loss: ${progress.loss.toFixed(4)}`;
        if (epoch_display) epoch_display.textContent = `Epoch: ${progress.epoch}/${progress.total_epochs}`;
        update_loss_chart(loss_chart, embedder.loss_history);
      },
      () => {
        // training complete
        if (status_el) {
          status_el.textContent = 'Trained';
          status_el.classList.add('trained');
        }
        if (train_button) {
          train_button.disabled = false;
          train_button.textContent = 'Retrain';
        }
        update_loss_chart(loss_chart, embedder.loss_history);

        // persist the trained model to storage (per-user, encrypted at rest)
        save_model(active_username, embedder.serialize(), session_key);

        // apply clustering to the rendered tabs
        apply_clustering_to_tabs(decrypted_groups);
      }
    );
  } catch (error) {
    if (status_el) status_el.textContent = `Error: ${error.message}`;
    if (train_button) { train_button.disabled = false; train_button.textContent = 'Train Model'; }
  }
}

// render the loss chart as a row of vertical bars
function update_loss_chart(chart_el, loss_history) {
  if (!chart_el || !loss_history || loss_history.length === 0) return;

  chart_el.innerHTML = '';
  const max_loss = Math.max(...loss_history);
  const min_loss = Math.min(...loss_history);
  const range = max_loss - min_loss || 1;

  for (let i = 0; i < loss_history.length; i++) {
    const bar = document.createElement('div');
    bar.className = 'loss-bar';
    // normalize to 0-100% height relative to the loss range
    const normalized = (loss_history[i] - min_loss) / range;
    const height_pct = Math.max(5, 100 - (normalized * 90));
    bar.style.height = `${height_pct}%`;
    bar.title = `Epoch ${i + 1}: ${loss_history[i].toFixed(4)}`;
    chart_el.appendChild(bar);
  }
}

// compute embeddings for all tabs and apply k-means clustering
// adds a colored cluster badge to each tab item in the dom
function apply_clustering_to_tabs(decrypted_groups) {
  // collect all tab elements and their text
  const tab_elements = [...document.querySelectorAll('.tab-item')];
  const tab_texts = [];
  const tab_el_map = [];

  tab_elements.forEach((el, i) => {
    const link = el.querySelector('.tab-link');
    if (link) {
      const text = link.textContent + ' ' + (link.getAttribute('href') || '');
      tab_texts.push(text);
      tab_el_map.push(el);
    }
  });

  if (tab_texts.length < 2) return;

  // embed each tab text
  const embeddings = tab_texts.map(text => embedder.embed_text(text));

  // run k-means with k = min(5, number of tabs)
  const k = Math.min(5, tab_texts.length);
  const assignments = kmeans_cluster(embeddings, k, 30);

  // cluster colors
  const cluster_colors = ['#e94560', '#4caf50', '#2196f3', '#ff9800', '#9c27b0'];

  // add cluster badge to each tab
  tab_el_map.forEach((el, i) => {
    // remove old badge if present
    const old_badge = el.querySelector('.cluster-badge');
    if (old_badge) old_badge.remove();

    const badge = document.createElement('span');
    badge.className = 'cluster-badge';
    badge.style.backgroundColor = cluster_colors[assignments[i] % cluster_colors.length];
    badge.title = `Cluster ${assignments[i] + 1}`;
    el.insertBefore(badge, el.firstChild);
  });
}

// semantic search: rank tabs by cosine similarity to the query
// uses the trained embedding model instead of simple text matching.
// the dom reorder it performs is visual only and is never persisted; the
// original order is snapshotted in search_state so filter_tabs_by_search can
// restore it when the query is cleared or the toggle is flipped off.
function semantic_search_tabs(query) {
  if (!embedder.is_trained || !query.trim()) {
    // fall back to regular search if model is not trained
    filter_tabs_by_search();
    return;
  }

  const query_embedding = embedder.embed_text(query);
  const tab_elements = document.querySelectorAll('.tab-item');

  // snapshot the current tab and group-card order on the first semantic pass
  // after a render, so we can restore it later. we do this before any reorder.
  if (!search_state.order_saved) {
    search_state.tab_order = [];
    tab_elements.forEach(el => {
      const parent = el.parentElement;
      if (parent && el.dataset.tabId) {
        search_state.tab_order.push({ parent_id: parent.id, tab_id: el.dataset.tabId });
      }
    });
    search_state.group_order = [];
    document.querySelectorAll('.group-card').forEach(card => {
      if (card.dataset.groupId) search_state.group_order.push(card.dataset.groupId);
    });
    search_state.order_saved = true;
  }

  // collect tab data and compute similarities
  const tab_scores = [];
  tab_elements.forEach((el, i) => {
    const link = el.querySelector('.tab-link');
    if (!link) return;
    const text = link.textContent + ' ' + (link.getAttribute('href') || '');
    const tab_embedding = embedder.embed_text(text);
    const similarity = calculate_cosine_similarity(query_embedding, tab_embedding);
    tab_scores.push({ element: el, score: similarity });
  });

  // sort all tabs by similarity score descending
  tab_scores.sort((a, b) => b.score - a.score);

  // collect the unique group cards in score order (best group first).
  // build a list of { card, container } so we can re-insert them in order.
  const ordered_groups = [];
  const groups_seen = new Set();
  tab_scores.forEach(item => {
    const group_card = item.element.closest('.group-card');
    if (group_card && !groups_seen.has(group_card)) {
      groups_seen.add(group_card);
      ordered_groups.push({ card: group_card, container: group_card.parentElement });
    }
  });

  // re-insert group cards so the best group ends up at the top of the container.
  // ordered_groups is best-first, so appending best first moves it to the end,
  // then each subsequent (worse) group is appended after it. because appendChild
  // moves an existing child instead of duplicating, the final order is best-first.
  for (let i = 0; i < ordered_groups.length; i++) {
    const { card, container } = ordered_groups[i];
    if (container) container.appendChild(card);
  }

  // reorder tabs within their groups by score, best first. group tabs by their
  // parent element first to avoid touching unrelated lists.
  const by_parent = new Map();
  tab_scores.forEach(item => {
    const parent = item.element.parentElement;
    if (!parent) return;
    if (!by_parent.has(parent)) by_parent.set(parent, []);
    by_parent.get(parent).push(item.element);
  });
  // tab_scores is best-first per group, so appending best first lands it at
  // the top of the list once all moves are done.
  by_parent.forEach((els, parent) => {
    for (let i = 0; i < els.length; i++) parent.appendChild(els[i]);
  });

  // show all tabs and tag them with their similarity score. only set the tooltip
  // when the score is positive so near-zero matches don't show misleading "0.0%".
  tab_scores.forEach(item => {
    item.element.style.display = '';
    if (item.score > 0) {
      item.element.title = `Similarity: ${(item.score * 100).toFixed(1)}%`;
    } else {
      item.element.removeAttribute('title');
    }
  });

  // show all group cards
  document.querySelectorAll('.group-card').forEach(card => {
    card.style.display = '';
  });
}
