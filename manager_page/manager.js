import {
  get_credentials, get_tab_groups, save_tab_groups,
  get_session_key, store_session_key, clear_session_key,
  get_settings, save_settings
} from '../common/storage.js';
import {
  derive_key_from_password, decrypt, encrypt,
  base64_to_array_buffer
} from '../common/crypto.js';

const VERIFIER_STRING = 'aegis-verification-string';

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

const settings = { always_private: false };

// tracks the currently dragged tab element for drag-and-drop reordering
const drag_state = {
  dragged_element: null,
  dragged_group_id: null
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

  await load_settings();
  always_private_toggle.checked = settings.always_private;
  check_incognito_permission();

  always_private_toggle.addEventListener('change', (e) => {
    settings.always_private = e.target.checked;
    save_settings(settings);
  });

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
        const groups = await get_tab_groups();
        if (groups.length === 0) {
          alert('No saved tabs to export.');
          return;
        }

        // build the backup object with metadata
        const backup_data = {
          format: 'aegis-backup',
          version: 1,
          exported_at: new Date().toISOString(),
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

        // merge: load existing groups, then add backup groups
        // avoid duplicates by checking group ids
        const existing_groups = await get_tab_groups();
        const existing_ids = new Set(existing_groups.map(g => g.id));
        let added_count = 0;

        for (const group of backup_data.groups) {
          if (!existing_ids.has(group.id)) {
            existing_groups.unshift(group);
            added_count++;
          }
        }

        await save_tab_groups(existing_groups);
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

  // search filter
  if (search_input) {
    search_input.addEventListener('input', filter_tabs_by_search);
  }

  // lock button: clear session key and show password prompt
  if (lock_button) {
    lock_button.addEventListener('click', async () => {
      await clear_session_key();
      selection_state.selected_tabs.clear();
      selection_state.all_tab_elements = [];
      groups_container.innerHTML = '';
      groups_container.classList.add('hidden');
      password_prompt_view.classList.remove('hidden');
      setTimeout(() => manager_password.focus(), 100);
    });
  }

  // floating action panel buttons
  setup_action_panel();

  const session_key = await get_session_key();
  if (session_key) {
    render_page(session_key);
  } else {
    loading_message.classList.add('hidden');
    password_prompt_view.classList.remove('hidden');
    setTimeout(() => manager_password.focus(), 100);

    manager_password.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') manager_unlock_button.click();
    });

    manager_unlock_button.addEventListener('click', async () => {
      const password = manager_password.value;
      manager_error.classList.add('hidden');
      if (!password) {
        manager_error.textContent = 'Please enter your password';
        manager_error.classList.remove('hidden');
        return;
      }

      manager_unlock_button.disabled = true;
      manager_unlock_button.textContent = 'Unlocking...';

      try {
        const credentials = await get_credentials();
        if (!credentials) throw new Error('No credentials');

        const salt = base64_to_array_buffer(credentials.password_salt);
        const key = await derive_key_from_password(password, salt);
        const decrypted_verifier = await decrypt(credentials.password_verifier, key);

        if (decrypted_verifier === VERIFIER_STRING) {
          await store_session_key(key);
          password_prompt_view.classList.add('hidden');
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
      let hostname = url;
      try { hostname = new URL(url).hostname; } catch (e) {}
      return { title: `${prefix}: ${hostname}`, url: url, fav_icon_url: null };
    })
  };

  const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
  const new_group = {
    id: Date.now().toString(),
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext
  };
  const groups = await get_tab_groups();
  groups.unshift(new_group);
  await save_tab_groups(groups);
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
        const link = el.querySelector('.tab-link');
        if (link) {
          const href = link.getAttribute('href');
          if (href) urls.push(href);
        }
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

    // Escape: clear selection and hide panels
    if (e.key === 'Escape') {
      clear_selection();
    }
  });
}

// open selected tabs, or if nothing selected, open the focused tab
async function open_selected_or_focused() {
  const selected = get_selected_tab_elements();
  let urls = [];

  if (selected.length > 0) {
    selected.forEach(el => {
      const link = el.querySelector('.tab-link');
      if (link) {
        const href = link.getAttribute('href');
        if (href) urls.push(href);
      }
    });
  } else {
    // fallback: open the focused tab
    const tabs = selection_state.all_tab_elements;
    if (selection_state.focused_index >= 0 && tabs[selection_state.focused_index]) {
      const link = tabs[selection_state.focused_index].querySelector('.tab-link');
      if (link) {
        const href = link.getAttribute('href');
        if (href) urls.push(href);
      }
    }
  }

  if (urls.length > 0) {
    await restore_tabs_batched(urls, settings.always_private);
  }
}

function delete_selected_items() {
  if (selection_state.selected_tabs.size === 0) return;
  selection_state.selected_tabs.forEach((tab) => {
    soft_delete_tab(tab, tab.dataset.groupId, parseInt(tab.dataset.tabIndex, 10));
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
  if (e.target.classList.contains('tab-delete-button') || e.target.classList.contains('tab-link')) return;
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

function soft_delete_tab(tab_element, group_id, tab_index) {
  tab_element.classList.add('fade-out');
  const deletion = {
    type: 'tab',
    element: tab_element,
    group_id: group_id,
    tab_index: tab_index,
    timeout_id: null
  };
  const existing_index = delete_state.pending_deletions.findIndex(d => d.element === tab_element);
  if (existing_index >= 0) {
    clearTimeout(delete_state.pending_deletions[existing_index].timeout_id);
    delete_state.pending_deletions.splice(existing_index, 1);
  }
  deletion.timeout_id = setTimeout(() => commit_deletion(deletion), 5000);
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
  deletion.timeout_id = setTimeout(() => commit_deletion(deletion), 5000);
  delete_state.pending_deletions.push(deletion);
  show_undo_toast();
}

async function commit_deletion(deletion) {
  try {
    const groups = await get_tab_groups();
    const session_key = await get_session_key();

    if (deletion.type === 'group') {
      const updated_groups = groups.filter(g => g.id !== deletion.group_id);
      await save_tab_groups(updated_groups);
      deletion.element.remove();
      if (updated_groups.length === 0) {
        document.getElementById('groups-container').innerHTML =
          '<div class="empty-state"><p>No saved tabs found.</p></div>';
      }
    } else if (deletion.type === 'tab') {
      const group_index = groups.findIndex(g => g.id === deletion.group_id);
      if (group_index !== -1 && session_key) {
        const group_data = JSON.parse(await decrypt(groups[group_index], session_key));
        group_data.tabs.splice(deletion.tab_index, 1);
        if (group_data.tabs.length === 0) {
          groups.splice(group_index, 1);
          deletion.element.closest('.group-card')?.remove();
        } else {
          const encrypted = await encrypt(JSON.stringify(group_data), session_key);
          groups[group_index] = {
            id: deletion.group_id,
            iv: encrypted.iv,
            ciphertext: encrypted.ciphertext
          };
          deletion.element.remove();
        }
        await save_tab_groups(groups);
      }
    }

    const index = delete_state.pending_deletions.indexOf(deletion);
    if (index >= 0) delete_state.pending_deletions.splice(index, 1);
    if (delete_state.pending_deletions.length === 0) hide_undo_toast();
  } catch (error) {
    // deletion failed silently, element stays visible
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
  const undo_button = document.getElementById('undo-button');
  const timer_span = document.getElementById('toast-timer');
  const message_span = document.getElementById('toast-message');
  const count = delete_state.pending_deletions.length;
  message_span.textContent = count === 1 ? 'Deleted' : `${count} items deleted`;

  toast.classList.remove('hidden');
  const new_undo_button = undo_button.cloneNode(true);
  undo_button.parentNode.replaceChild(new_undo_button, undo_button);
  new_undo_button.addEventListener('click', undo_all_deletions);

  let seconds_left = 5;
  timer_span.textContent = `(${seconds_left}s)`;
  if (delete_state.timer_interval) clearInterval(delete_state.timer_interval);
  delete_state.timer_interval = setInterval(() => {
    seconds_left--;
    if (seconds_left <= 0) {
      clearInterval(delete_state.timer_interval);
      hide_undo_toast();
    } else {
      timer_span.textContent = `(${seconds_left}s)`;
    }
  }, 1000);
}

function hide_undo_toast() {
  document.getElementById('undo-toast').classList.add('hidden');
  if (delete_state.timer_interval) clearInterval(delete_state.timer_interval);
}

// restore tabs in batches to avoid overwhelming the browser
async function restore_tabs_batched(urls, incognito = false) {
  if (urls.length === 0) return;

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
      url: urls[0],
      incognito: incognito
    });

    // batch the remaining urls: create them all without artificial delay
    const remaining_urls = urls.slice(1);
    const batch_size = 10;

    for (let i = 0; i < remaining_urls.length; i += batch_size) {
      const batch = remaining_urls.slice(i, i + batch_size);
      const create_promises = batch.map(url =>
        chrome.tabs.create({
          windowId: new_window.id,
          url: url,
          active: false
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
    const encrypted_groups = await get_tab_groups();

    if (encrypted_groups.length === 0) {
      groups_container.innerHTML = '<div class="empty-state"><p>No saved tabs found.</p></div>';
      loading_message.classList.add('hidden');
      groups_container.classList.remove('hidden');
      return;
    }

    // decrypt all groups in parallel for speed
    const decrypt_promises = encrypted_groups.map(group =>
      decrypt(group, key).then(plaintext => ({
        id: group.id,
        data: JSON.parse(plaintext)
      })).catch(() => null)
    );

    const decrypted_results = await Promise.all(decrypt_promises);

    // render groups in original order
    let group_index = 0;
    for (const result of decrypted_results) {
      if (!result) continue;
      groups_container.appendChild(
        create_group_element(result.id, result.data, group_index)
      );
      group_index++;
    }

    loading_message.classList.add('hidden');
    groups_container.classList.remove('hidden');
  } catch (error) {
    loading_message.innerHTML = '<p class="error">Error loading saved tabs</p>';
  }
}

function create_group_element(group_id, group_data, group_index = 0) {
  const group_element = document.createElement('div');
  group_element.className = 'group-card';
  group_element.dataset.groupId = group_id;
  group_element.style.animationDelay = `${group_index * 0.05}s`;

  const date = new Date(group_data.date);
  const formatted_date = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <h3>Saved on ${formatted_date} (${group_data.tabs.length} tabs)</h3>
    <div class="group-actions">
      <button class="restore-button secondary-button">Restore All</button>
      <button class="restore-private-button private-restore-button">Private</button>
      <button class="export-urls-button secondary-button">Export URLs</button>
      <button class="delete-button">Delete</button>
    </div>
  `;

  const tabs_list = document.createElement('div');
  tabs_list.className = 'tabs-list';

  group_data.tabs.forEach((tab, tab_index) => {
    const tab_element = document.createElement('div');
    tab_element.className = 'tab-item';
    tab_element.dataset.groupId = group_id;
    tab_element.dataset.tabIndex = tab_index;
    tab_element.draggable = true;

    const favicon = tab.fav_icon_url
      ? `<img src="${tab.fav_icon_url}" alt="favicon" class="favicon" onerror="this.style.display='none'">`
      : '<div class="favicon-placeholder"></div>';
    tab_element.innerHTML =
      `${favicon}<a href="${tab.url}" target="_blank" class="tab-link">${tab.title}</a>` +
      `<button class="tab-delete-button" data-tab-index="${tab_index}">x</button>`;

    tab_element.addEventListener('click', (e) => handle_tab_click(e, tab_element, tab_index, group_id));
    tab_element.querySelector('.tab-delete-button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      soft_delete_tab(tab_element, group_id, tab_index);
    });

    // drag-and-drop reordering within the same group
    // stores a reference to the dragged element, then on drop reorders
    // the dom and persists the new order to encrypted storage
    tab_element.addEventListener('dragstart', (e) => {
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

// filter visible tabs based on search input
function filter_tabs_by_search() {
  const search_input = document.getElementById('search-input');
  if (!search_input) return;
  const query = search_input.value.toLowerCase().trim();

  const all_tab_items = document.querySelectorAll('.tab-item');
  let visible_count = 0;

  all_tab_items.forEach(tab_item => {
    const tab_link = tab_item.querySelector('.tab-link');
    if (!tab_link) return;
    const title_text = tab_link.textContent.toLowerCase();
    const url_text = tab_link.getAttribute('href')?.toLowerCase() || '';
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

    const groups = await get_tab_groups();
    const group_index = groups.findIndex(g => g.id === group_id);
    if (group_index === -1) return;

    const group_data = JSON.parse(await decrypt(groups[group_index], session_key));
    const tab_elements = tabs_list_element.querySelectorAll('.tab-item');
    const reordered_tabs = [];

    // read the links from each dom element in the new order
    // and match them back to the original tab data by url
    tab_elements.forEach(el => {
      const link = el.querySelector('.tab-link');
      if (link) {
        const url = link.getAttribute('href');
        const match = group_data.tabs.find(t => t.url === url);
        if (match) reordered_tabs.push(match);
      }
    });

    if (reordered_tabs.length !== group_data.tabs.length) return;

    group_data.tabs = reordered_tabs;
    const encrypted = await encrypt(JSON.stringify(group_data), session_key);
    groups[group_index] = {
      id: group_id,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext
    };
    await save_tab_groups(groups);

    // update the tabIndex attributes to reflect the new order
    tab_elements.forEach((el, i) => {
      el.dataset.tabIndex = i;
    });

    // rebuild the all_tab_elements array for keyboard navigation
    selection_state.all_tab_elements = [...document.querySelectorAll('.tab-item')];
  } catch (error) {
    // reorder failed to persist, but the dom is already updated
    // a page reload will revert to the stored order
  }
}
