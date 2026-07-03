// background service worker for Aegis Tab
// handles the right-click context menu to save the current tab
// uses static ES module imports (requires "type": "module" in manifest)

import {
  get_session_key, get_session_user,
  get_tab_groups, save_tab_groups
} from './common/storage.js';
import { encrypt } from './common/crypto.js';
import { get_url_status, derive_title_from_url } from './common/urls.js';

// create the context menu item when the extension is installed
// onInstalled fires on install AND on update, so remove any existing
// item first to avoid the duplicate id error on browser restart
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'aegis-save-current-tab',
      title: 'Save to Aegis Tab',
      contexts: ['page', 'link']
    });
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
