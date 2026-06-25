import { 
  getCredentials, 
  getTabGroups, 
  saveTabGroups, 
  getSessionKey, 
  storeSessionKey 
} from './storage.js';
import { 
  deriveKeyFromPassword, 
  decrypt, 
  encrypt,
  base64ToArrayBuffer 
} from './crypto.js';

// Phases 2-4 States
const SelectionState = { selectedTabs: new Set(), lastClickedIndex: -1, currentGroupId: null, focusedIndex: -1, allTabElements: [] };
const DeleteState = { pendingDeletions: [], toastVisible: false };
const Settings = { alwaysPrivate: false };

document.addEventListener('DOMContentLoaded', async () => {
  const loadingMessage = document.getElementById('loading-message');
  const passwordPromptView = document.getElementById('password-prompt-view');
  const groupsContainer = document.getElementById('groups-container');
  const managerPassword = document.getElementById('manager-password');
  const managerError = document.getElementById('manager-error');
  const managerUnlockButton = document.getElementById('manager-unlock-button');
  const importButton = document.getElementById('import-button');
  const importFile = document.getElementById('import-file');
  const pasteUrlsButton = document.getElementById('paste-urls-button');
  const alwaysPrivateToggle = document.getElementById('always-private-toggle');
  
  await loadSettings();
  alwaysPrivateToggle.checked = Settings.alwaysPrivate;
  checkIncognitoPermission();
  
  alwaysPrivateToggle.addEventListener('change', (e) => {
    Settings.alwaysPrivate = e.target.checked;
    saveSettings();
  });
  
  document.getElementById('dismiss-warning')?.addEventListener('click', () => {
    document.getElementById('incognito-warning').classList.add('hidden');
  });
  
  importButton.addEventListener('click', () => importFile.click());
  
  importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const urls = text.split('\n').map(url => url.trim()).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
      if (urls.length === 0) return alert('No valid URLs found.');
      await saveUrlsAsGroup(urls, 'Imported');
    } catch (error) {
      alert(`Failed to import URLs: ${error.message}`);
    }
    importFile.value = '';
  });
  
  setupPasteModal();
  pasteUrlsButton.addEventListener('click', openPasteModal);
  setupKeyboardShortcuts();
  
  const sessionKey = await getSessionKey();
  if (sessionKey) {
    renderPage(sessionKey);
  } else {
    loadingMessage.classList.add('hidden');
    passwordPromptView.classList.remove('hidden');
    setTimeout(() => managerPassword.focus(), 100);
    
    managerPassword.addEventListener('keypress', (e) => { if (e.key === 'Enter') managerUnlockButton.click(); });
    
    managerUnlockButton.addEventListener('click', async () => {
      const password = managerPassword.value;
      managerError.classList.add('hidden');
      if (!password) { managerError.textContent = 'Please enter your password'; managerError.classList.remove('hidden'); return; }
      
      managerUnlockButton.disabled = true;
      managerUnlockButton.textContent = 'Unlocking...';
      
      try {
        const credentials = await getCredentials();
        if (!credentials) throw new Error('No credentials');
        
        const salt = base64ToArrayBuffer(credentials.passwordSalt);
        const key = await deriveKeyFromPassword(password, salt);
        const decryptedVerifier = await decrypt(credentials.passwordVerifier, key);
        
        if (decryptedVerifier === 'aegis-verification-string') {
          await storeSessionKey(key);
          passwordPromptView.classList.add('hidden');
          renderPage(key);
        } else throw new Error('Decryption failed');
      } catch (error) {
        managerError.textContent = 'Incorrect password';
        managerError.classList.remove('hidden');
        managerUnlockButton.disabled = false;
        managerUnlockButton.textContent = 'Unlock';
      }
    });
  }
});

async function checkIncognitoPermission() {
  try {
    const isAllowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!isAllowed) document.getElementById('incognito-warning').classList.remove('hidden');
  } catch (error) {}
}

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get('aegis_settings');
    if (result.aegis_settings) Settings.alwaysPrivate = result.aegis_settings.alwaysPrivate || false;
  } catch (error) {}
}

async function saveSettings() {
  try { await chrome.storage.local.set({ aegis_settings: { alwaysPrivate: Settings.alwaysPrivate } }); } catch (error) {}
}

function setupPasteModal() {
  const modal = document.getElementById('paste-modal');
  const closeBtn = document.getElementById('close-paste-modal');
  const cancelBtn = document.getElementById('cancel-paste');
  const saveBtn = document.getElementById('save-pasted-urls');
  const textarea = document.getElementById('paste-textarea');
  
  closeBtn.addEventListener('click', closePasteModal);
  cancelBtn.addEventListener('click', closePasteModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closePasteModal(); });
  
  saveBtn.addEventListener('click', async () => {
    const text = textarea.value;
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const matches = text.match(urlRegex);
    if (!matches || matches.length === 0) return alert('No valid URLs found.');
    const uniqueUrls = [...new Set(matches)];
    await saveUrlsAsGroup(uniqueUrls, 'Pasted');
    closePasteModal();
  });
}

function openPasteModal() {
  document.getElementById('paste-modal').classList.remove('hidden');
  document.getElementById('paste-textarea').value = '';
  setTimeout(() => document.getElementById('paste-textarea').focus(), 100);
}

function closePasteModal() { document.getElementById('paste-modal').classList.add('hidden'); }

async function saveUrlsAsGroup(urls, prefix = 'Imported') {
  const sessionKey = await getSessionKey();
  if (!sessionKey) return alert('Please unlock first.');
  
  const tabData = {
    date: new Date().toISOString(),
    tabs: urls.map(url => {
      let hostname = url;
      try { hostname = new URL(url).hostname; } catch (e) {}
      return { title: `${prefix}: ${hostname}`, url: url, favIconUrl: null };
    })
  };
  
  const encrypted = await encrypt(JSON.stringify(tabData), sessionKey);
  const newGroup = { id: Date.now().toString(), iv: encrypted.iv, ciphertext: encrypted.ciphertext };
  const groups = await getTabGroups();
  groups.unshift(newGroup); 
  await saveTabGroups(groups);
  location.reload();
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelectedItems(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); selectAllInCurrentGroup(); }
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); moveFocus(1); }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); moveFocus(-1); }
    if (e.key === 'Enter') { e.preventDefault(); toggleFocusedSelection(); }
    if (e.key === 'Escape') clearSelection();
  });
}

function deleteSelectedItems() {
  if (SelectionState.selectedTabs.size === 0) return;
  SelectionState.selectedTabs.forEach((tab) => {
    softDeleteTab(tab, tab.dataset.groupId, parseInt(tab.dataset.tabIndex, 10));
  });
}

function selectAllInCurrentGroup() {
  let targetGroup = SelectionState.currentGroupId ? document.querySelector(`[data-group-id="${SelectionState.currentGroupId}"]`) : document.querySelector('.group-card');
  if (targetGroup) {
    targetGroup.querySelectorAll('.tab-item').forEach(tab => {
      SelectionState.selectedTabs.add(tab);
      tab.classList.add('selected');
    });
    SelectionState.currentGroupId = targetGroup.dataset.groupId;
  }
}

function moveFocus(direction) {
  const tabs = SelectionState.allTabElements;
  if (tabs.length === 0) return;
  if (SelectionState.focusedIndex >= 0 && tabs[SelectionState.focusedIndex]) tabs[SelectionState.focusedIndex].classList.remove('focused');
  
  let newIndex = Math.max(0, Math.min(SelectionState.focusedIndex + direction, tabs.length - 1));
  SelectionState.focusedIndex = newIndex;
  
  if (tabs[newIndex]) {
    tabs[newIndex].classList.add('focused');
    tabs[newIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    SelectionState.currentGroupId = tabs[newIndex].dataset.groupId;
  }
}

function toggleFocusedSelection() {
  const tabs = SelectionState.allTabElements;
  if (SelectionState.focusedIndex >= 0 && tabs[SelectionState.focusedIndex]) {
    const tab = tabs[SelectionState.focusedIndex];
    if (SelectionState.selectedTabs.has(tab)) { SelectionState.selectedTabs.delete(tab); tab.classList.remove('selected'); }
    else { SelectionState.selectedTabs.add(tab); tab.classList.add('selected'); }
  }
}

function clearSelection() {
  SelectionState.selectedTabs.forEach(tab => tab.classList.remove('selected'));
  SelectionState.selectedTabs.clear();
  SelectionState.lastClickedIndex = -1;
}

function handleTabClick(e, tabElement, tabIndex, groupId) {
  if (e.target.classList.contains('tab-delete-button') || e.target.classList.contains('tab-link')) return;
  e.preventDefault();
  
  const allTabs = SelectionState.allTabElements;
  const globalIndex = allTabs.indexOf(tabElement);
  SelectionState.currentGroupId = groupId;
  
  if (e.shiftKey && SelectionState.lastClickedIndex >= 0) {
    const start = Math.min(SelectionState.lastClickedIndex, globalIndex);
    const end = Math.max(SelectionState.lastClickedIndex, globalIndex);
    for (let i = start; i <= end; i++) {
      if (allTabs[i] && allTabs[i].dataset.groupId === groupId) {
        SelectionState.selectedTabs.add(allTabs[i]);
        allTabs[i].classList.add('selected');
      }
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (SelectionState.selectedTabs.has(tabElement)) { SelectionState.selectedTabs.delete(tabElement); tabElement.classList.remove('selected'); }
    else { SelectionState.selectedTabs.add(tabElement); tabElement.classList.add('selected'); }
  } else {
    clearSelection();
    SelectionState.selectedTabs.add(tabElement);
    tabElement.classList.add('selected');
  }
  SelectionState.lastClickedIndex = globalIndex;
}

function softDeleteTab(tabElement, groupId, tabIndex) {
  tabElement.classList.add('fade-out');
  const deletion = { type: 'tab', element: tabElement, groupId: groupId, tabIndex: tabIndex, timeoutId: null };
  const existingIndex = DeleteState.pendingDeletions.findIndex(d => d.element === tabElement);
  if (existingIndex >= 0) { clearTimeout(DeleteState.pendingDeletions[existingIndex].timeoutId); DeleteState.pendingDeletions.splice(existingIndex, 1); }
  deletion.timeoutId = setTimeout(() => commitDeletion(deletion), 5000);
  DeleteState.pendingDeletions.push(deletion);
  showUndoToast();
}

function softDeleteGroup(groupElement, groupId) {
  groupElement.classList.add('fade-out');
  const deletion = { type: 'group', element: groupElement, groupId: groupId, timeoutId: null };
  deletion.timeoutId = setTimeout(() => commitDeletion(deletion), 5000);
  DeleteState.pendingDeletions.push(deletion);
  showUndoToast();
}

async function commitDeletion(deletion) {
  try {
    const groups = await getTabGroups();
    const sessionKey = await getSessionKey();
    if (deletion.type === 'group') {
      const updatedGroups = groups.filter(g => g.id !== deletion.groupId);
      await saveTabGroups(updatedGroups);
      deletion.element.remove();
      if (updatedGroups.length === 0) document.getElementById('groups-container').innerHTML = '<div class="empty-state"><p>No saved tabs found.</p></div>';
    } else if (deletion.type === 'tab') {
      const groupIndex = groups.findIndex(g => g.id === deletion.groupId);
      if (groupIndex !== -1 && sessionKey) {
        const groupData = JSON.parse(await decrypt(groups[groupIndex], sessionKey));
        groupData.tabs.splice(deletion.tabIndex, 1);
        if (groupData.tabs.length === 0) {
          groups.splice(groupIndex, 1);
          deletion.element.closest('.group-card')?.remove();
        } else {
          const encrypted = await encrypt(JSON.stringify(groupData), sessionKey);
          groups[groupIndex] = { id: deletion.groupId, iv: encrypted.iv, ciphertext: encrypted.ciphertext };
          deletion.element.remove();
        }
        await saveTabGroups(groups);
      }
    }
    const index = DeleteState.pendingDeletions.indexOf(deletion);
    if (index >= 0) DeleteState.pendingDeletions.splice(index, 1);
    if (DeleteState.pendingDeletions.length === 0) hideUndoToast();
  } catch (error) {}
}

function undoAllDeletions() {
  DeleteState.pendingDeletions.forEach(deletion => {
    clearTimeout(deletion.timeoutId);
    deletion.element.classList.remove('fade-out');
    if (deletion.type === 'tab') SelectionState.selectedTabs.delete(deletion.element);
  });
  DeleteState.pendingDeletions = [];
  hideUndoToast();
}

function showUndoToast() {
  const toast = document.getElementById('undo-toast');
  const undoButton = document.getElementById('undo-button');
  const timerSpan = document.getElementById('toast-timer');
  const messageSpan = document.getElementById('toast-message');
  const count = DeleteState.pendingDeletions.length;
  messageSpan.textContent = count === 1 ? 'Deleted' : `${count} items deleted`;
  
  toast.classList.remove('hidden');
  const newUndoButton = undoButton.cloneNode(true);
  undoButton.parentNode.replaceChild(newUndoButton, undoButton);
  newUndoButton.addEventListener('click', undoAllDeletions);
  
  let secondsLeft = 5;
  timerSpan.textContent = `(${secondsLeft}s)`;
  if (DeleteState.timerInterval) clearInterval(DeleteState.timerInterval);
  DeleteState.timerInterval = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) { clearInterval(DeleteState.timerInterval); hideUndoToast(); }
    else timerSpan.textContent = `(${secondsLeft}s)`;
  }, 1000);
}

function hideUndoToast() {
  document.getElementById('undo-toast').classList.add('hidden');
  if (DeleteState.timerInterval) clearInterval(DeleteState.timerInterval);
}

// STABILITY UPGRADE: Safe Tab Restoration Batching
async function restoreTabsSafely(urls, incognito = false) {
  if (urls.length === 0) return;
  
  try {
    if (incognito) {
      const isAllowed = await chrome.extension.isAllowedIncognitoAccess();
      if (!isAllowed) {
        alert('Private browsing access is not enabled. Please enable "Allow in Incognito" in Chrome extension settings.');
        return;
      }
    }
    
    // Create the window with the first URL
    const newWindow = await chrome.windows.create({ 
      url: urls[0], 
      incognito: incognito 
    });

    // Open the rest one by one with a tiny delay to prevent crashing
    for (let i = 1; i < urls.length; i++) {
      await chrome.tabs.create({ 
        windowId: newWindow.id, 
        url: urls[i], 
        active: false 
      });
      // 300ms delay to let the CPU breathe
      await new Promise(resolve => setTimeout(resolve, 300)); 
    }
  } catch (error) {
    console.error('Error in safe restore:', error);
    alert(`Failed to restore some tabs: ${error.message}`);
  }
}

async function renderPage(key) {
  const loadingMessage = document.getElementById('loading-message');
  const groupsContainer = document.getElementById('groups-container');
  loadingMessage.classList.remove('hidden');
  groupsContainer.classList.add('hidden');
  
  try {
    groupsContainer.innerHTML = '';
    SelectionState.allTabElements = [];
    const encryptedGroups = await getTabGroups();
    
    if (encryptedGroups.length === 0) {
      groupsContainer.innerHTML = '<div class="empty-state"><p>No saved tabs found.</p></div>';
      loadingMessage.classList.add('hidden');
      groupsContainer.classList.remove('hidden');
      return;
    }
    
    for (let groupIndex = 0; groupIndex < encryptedGroups.length; groupIndex++) {
      try {
        const groupData = JSON.parse(await decrypt(encryptedGroups[groupIndex], key));
        groupsContainer.appendChild(createGroupElement(encryptedGroups[groupIndex].id, groupData, groupIndex));
      } catch (error) {}
    }
    
    loadingMessage.classList.add('hidden');
    groupsContainer.classList.remove('hidden');
  } catch (error) {
    loadingMessage.innerHTML = '<p class="error">Error loading saved tabs</p>';
  }
}

function createGroupElement(groupId, groupData, groupIndex = 0) {
  const groupElement = document.createElement('div');
  groupElement.className = 'group-card';
  groupElement.dataset.groupId = groupId;
  groupElement.style.animationDelay = `${groupIndex * 0.1}s`;
  
  const date = new Date(groupData.date);
  const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  
  const header = document.createElement('div');
  header.className = 'group-header';
  header.innerHTML = `
    <h3>Saved on ${formattedDate} (${groupData.tabs.length} tabs)</h3>
    <div class="group-actions">
      <button class="restore-button secondary-button">Restore All</button>
      <button class="restore-private-button private-restore-button">🕶️ Private</button>
      <button class="export-urls-button secondary-button">Export URLs</button>
      <button class="delete-button">Delete</button>
    </div>
  `;
  
  const tabsList = document.createElement('div');
  tabsList.className = 'tabs-list';
  
  groupData.tabs.forEach((tab, tabIndex) => {
    const tabElement = document.createElement('div');
    tabElement.className = 'tab-item';
    tabElement.dataset.groupId = groupId;
    tabElement.dataset.tabIndex = tabIndex;
    
    const favicon = tab.favIconUrl ? `<img src="${tab.favIconUrl}" alt="favicon" class="favicon" onerror="this.style.display='none'">` : '<div class="favicon-placeholder"></div>';
    tabElement.innerHTML = `${favicon}<a href="${tab.url}" target="_blank" class="tab-link">${tab.title}</a><button class="tab-delete-button" data-tab-index="${tabIndex}">×</button>`;
    
    tabElement.addEventListener('click', (e) => handleTabClick(e, tabElement, tabIndex, groupId));
    tabElement.querySelector('.tab-delete-button').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); softDeleteTab(tabElement, groupId, tabIndex); });
    
    tabsList.appendChild(tabElement);
    SelectionState.allTabElements.push(tabElement);
  });
  
  groupElement.appendChild(header);
  groupElement.appendChild(tabsList);
  
  // STABILITY FIX: Hook up the new safe batching restore logic
  groupElement.querySelector('.restore-button').addEventListener('click', async () => {
    const urls = groupData.tabs.map(tab => tab.url);
    if (Settings.alwaysPrivate) {
      await restoreTabsSafely(urls, true);
    } else {
      await restoreTabsSafely(urls, false);
    }
  });
  
  groupElement.querySelector('.restore-private-button').addEventListener('click', async () => {
    const urls = groupData.tabs.map(tab => tab.url);
    await restoreTabsSafely(urls, true);
  });
  
  groupElement.querySelector('.export-urls-button').addEventListener('click', async () => {
    const urlsText = groupData.tabs.map(tab => tab.url).join('\n');
    const blob = new Blob([urlsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `aegis-tab-urls-${new Date(groupData.date).toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  });
  
  groupElement.querySelector('.delete-button').addEventListener('click', () => softDeleteGroup(groupElement, groupId));
  
  return groupElement;
}