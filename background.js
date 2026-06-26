// background service worker for Aegis Tab
// handles the right-click context menu to save the current tab

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

  // dynamically import storage and crypto modules
  const [{ get_session_key, get_session_user, get_tab_groups, save_tab_groups },
         { encrypt }] = await Promise.all([
    import(chrome.runtime.getURL('common/storage.js')),
    import(chrome.runtime.getURL('common/crypto.js'))
  ]);

  const session_key = await get_session_key();
  const session_user = await get_session_user();

  if (!session_key || !session_user) {
    // not unlocked: open the popup so user can unlock
    chrome.action.openPopup?.();
    return;
  }

  // if right-clicked on a link, save the link url instead of the page
  const target_url = info.linkUrl || tab.url || tab.pendingUrl || '';
  if (!target_url ||
      target_url.startsWith('chrome://') ||
      target_url.startsWith('chrome-extension://') ||
      target_url.startsWith('about:')) {
    return;
  }

  let title = info.linkUrl ? info.linkUrl : tab.title;
  if (!title || title.trim() === '') {
    try { title = new URL(target_url).hostname; } catch (e) { title = 'Untitled'; }
  }

  const tab_data = {
    date: new Date().toISOString(),
    tabs: [{ title: title, url: target_url, fav_icon_url: tab.favIconUrl || null }]
  };

  const encrypted = await encrypt(JSON.stringify(tab_data), session_key);
  const groups = await get_tab_groups(session_user);
  groups.unshift({
    id: Date.now().toString(),
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext
  });
  await save_tab_groups(session_user, groups);
});
