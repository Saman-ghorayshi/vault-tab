// background service worker for Aegis Tab
// handles the right-click context menu to save the current tab
// uses static ES module imports (requires "type": "module" in manifest)

import {
  get_session_key, get_session_user,
  get_tab_groups, save_tab_groups
} from './common/storage.js';
import { encrypt } from './common/crypto.js';

// set of URL schemes that cannot be saved
const UNSAVEABLE_SCHEMES = ['chrome:', 'chrome-extension:', 'about:', 'edge:', 'brave:', 'devtools:'];

function is_unsaveable_url(url) {
  if (!url) return true;
  for (const scheme of UNSAVEABLE_SCHEMES) {
    if (url.startsWith(scheme)) return true;
  }
  return false;
}

// create the context menu item when the extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'aegis-save-current-tab',
    title: 'Save to Aegis Tab',
    contexts: ['page', 'link']
  });
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

    // determine saveable status
    let status = 'ok';
    if (!target_url) {
      return; // nothing to save
    }
    if (is_unsaveable_url(target_url)) {
      // save with metadata so the user sees it was recorded, but mark non-restorable
      status = 'unsaveable';
    }
    if (target_url.startsWith('file://')) {
      status = 'local_file';
    }

    let title = info.linkUrl ? info.linkUrl : tab.title;
    if (!title || title.trim() === '') {
      try { title = new URL(target_url).hostname; } catch (e) { title = 'Untitled'; }
    }

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
      id: Date.now().toString(),
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
