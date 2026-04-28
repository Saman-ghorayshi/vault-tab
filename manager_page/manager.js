import { 
  getCredentials, 
  getTabGroups, 
  saveTabGroups, 
  getSessionKey, 
  storeSessionKey 
} from '../common/storage.js';
import { 
  deriveKeyFromPassword, 
  decrypt, 
  encrypt,
  base64ToArrayBuffer 
} from '../common/crypto.js';

// =============================================
// PHASE 2: Selection State Management
// =============================================
const SelectionState = {
  selectedTabs: new Set(),
  lastClickedIndex: -1,
  currentGroupId: null,
  focusedIndex: -1,
  allTabElements: []
};

// =============================================
// PHASE 3: Soft Delete State
// =============================================
const DeleteState = {
  pendingDeletions: [], // { type: 'group'|'tab', element, groupId, tabIndex, timeoutId }
  toastVisible: false
};

// =============================================
// PHASE 4: Settings
// =============================================
const Settings = {
  alwaysPrivate: false
};

// =============================================
// Main Initialization
// =============================================
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
  
  // Load settings
  await loadSettings();
  alwaysPrivateToggle.checked = Settings.alwaysPrivate;
  
  // Check incognito permission
  checkIncognitoPermission();
  
  // Settings toggle listener
  alwaysPrivateToggle.addEventListener('change', (e) => {
    Settings.alwaysPrivate = e.target.checked;
    saveSettings();
  });
  
  // Dismiss incognito warning
  document.getElementById('dismiss-warning')?.addEventListener('click', () => {
    document.getElementById('incognito-warning').classList.add('hidden');
  });
  
  // Import file functionality
  importButton.addEventListener('click', () => {
    importFile.click();
  });
  
  importFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      const text = await file.text();
      const urls = text.split('\n')
        .map(url => url.trim())
        .filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
      
      if (urls.length === 0) {
        alert('No valid URLs found in the file. Make sure each URL is on a separate line.');
        return;
      }
      
      await saveUrlsAsGroup(urls, 'Imported');
      
    } catch (error) {
      console.error('Import error:', error);
      alert(`Failed to import URLs: ${error.message}`);
    }
    
    importFile.value = '';
  });
  
  // PHASE 5: Paste URLs Modal
  setupPasteModal();
  pasteUrlsButton.addEventListener('click', openPasteModal);
  
  // PHASE 2: Keyboard shortcuts
  setupKeyboardShortcuts();
  
  // Check if session key exists
  const sessionKey = await getSessionKey();
  
  if (sessionKey) {
    renderPage(sessionKey);
  } else {
    loadingMessage.classList.add('hidden');
    passwordPromptView.classList.remove('hidden');
    
    setTimeout(() => managerPassword.focus(), 100);
    
    managerPassword.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        managerUnlockButton.click();
      }
    });
    
    managerUnlockButton.addEventListener('click', async () => {
      const password = managerPassword.value;
      
      managerError.classList.add('hidden');
      
      if (!password) {
        managerError.textContent = 'Please enter your password';
        managerError.classList.remove('hidden');
        return;
      }
      
      managerUnlockButton.disabled = true;
      managerUnlockButton.textContent = 'Unlocking...';
      
      try {
        const credentials = await getCredentials();
        
        if (!credentials) {
          managerError.textContent = 'No credentials found. Please set up Aegis Tab first.';
          managerError.classList.remove('hidden');
          managerUnlockButton.disabled = false;
          managerUnlockButton.textContent = 'Unlock';
          return;
        }
        
        const salt = base64ToArrayBuffer(credentials.passwordSalt);
        const key = await deriveKeyFromPassword(password, salt);
        const decryptedVerifier = await decrypt(credentials.passwordVerifier, key);
        
        if (decryptedVerifier === 'aegis-verification-string') {
          await storeSessionKey(key);
          passwordPromptView.classList.add('hidden');
          renderPage(key);
        } else {
          throw new Error('Decryption failed');
        }
      } catch (error) {
        managerError.textContent = 'Incorrect password';
        managerError.classList.remove('hidden');
        console.error(error);
        managerUnlockButton.disabled = false;
        managerUnlockButton.textContent = 'Unlock';
      }
    });
  }
});

// =============================================
// PHASE 4: Check Incognito Permission
// =============================================
async function checkIncognitoPermission() {
  try {
    const isAllowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!isAllowed) {
      document.getElementById('incognito-warning').classList.remove('hidden');
    }
  } catch (error) {
    console.error('Could not check incognito permission:', error);
  }
}

// =============================================
// Settings Persistence
// =============================================
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get('aegis_settings');
    if (result.aegis_settings) {
      Settings.alwaysPrivate = result.aegis_settings.alwaysPrivate || false;
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ aegis_settings: { alwaysPrivate: Settings.alwaysPrivate } });
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

// =============================================
// PHASE 5: Paste URLs Modal
// =============================================
function setupPasteModal() {
  const modal = document.getElementById('paste-modal');
  const closeBtn = document.getElementById('close-paste-modal');
  const cancelBtn = document.getElementById('cancel-paste');
  const saveBtn = document.getElementById('save-pasted-urls');
  const textarea = document.getElementById('paste-textarea');
  
  closeBtn.addEventListener('click', closePasteModal);
  cancelBtn.addEventListener('click', closePasteModal);
  
  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closePasteModal();
    }
  });
  
  // Save pasted URLs
  saveBtn.addEventListener('click', async () => {
    const text = textarea.value;
    
    // PHASE 5: Regex to extract URLs
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const matches = text.match(urlRegex);
    
    if (!matches || matches.length === 0) {
      alert('No valid URLs found. Make sure URLs start with http:// or https://');
      return;
    }
    
    // Remove duplicates
    const uniqueUrls = [...new Set(matches)];
    
    await saveUrlsAsGroup(uniqueUrls, 'Pasted');
    closePasteModal();
  });
}

function openPasteModal() {
  const modal = document.getElementById('paste-modal');
  const textarea = document.getElementById('paste-textarea');
  modal.classList.remove('hidden');
  textarea.value = '';
  setTimeout(() => textarea.focus(), 100);
}

function closePasteModal() {
  const modal = document.getElementById('paste-modal');
  modal.classList.add('hidden');
}

// =============================================
// Save URLs as New Group (PHASE 1: .unshift())
// =============================================
async function saveUrlsAsGroup(urls, prefix = 'Imported') {
  const sessionKey = await getSessionKey();
  if (!sessionKey) {
    alert('Please unlock the extension first.');
    return;
  }
  
  const tabData = {
    date: new Date().toISOString(),
    tabs: urls.map(url => {
      let hostname = url;
      try {
        hostname = new URL(url).hostname;
      } catch (e) {}
      return {
        title: `${prefix}: ${hostname}`,
        url: url,
        favIconUrl: null
      };
    })
  };
  
  const encrypted = await encrypt(JSON.stringify(tabData), sessionKey);
  
  const newGroup = {
    id: Date.now().toString(),
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext
  };
  
  const groups = await getTabGroups();
  groups.unshift(newGroup); // ✅ PHASE 1: Newest first
  await saveTabGroups(groups);
  
  location.reload();
}

// =============================================
// PHASE 2: Keyboard Shortcuts
// =============================================
function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    // Don't trigger if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }
    
    // Delete key - soft delete selected items
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelectedItems();
    }
    
    // Ctrl/Cmd + A - Select all in current group
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      selectAllInCurrentGroup();
    }
    
    // J - Move focus down
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      moveFocus(1);
    }
    
    // K - Move focus up
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      moveFocus(-1);
    }
    
    // Enter - Toggle selection on focused item
    if (e.key === 'Enter') {
      e.preventDefault();
      toggleFocusedSelection();
    }
    
    // Escape - Clear selection
    if (e.key === 'Escape') {
      clearSelection();
    }
  });
}

function deleteSelectedItems() {
  if (SelectionState.selectedTabs.size === 0) return;
  
  SelectionState.selectedTabs.forEach((tabElement) => {
    const groupId = tabElement.dataset.groupId;
    const tabIndex = parseInt(tabElement.dataset.tabIndex, 10);
    softDeleteTab(tabElement, groupId, tabIndex);
  });
}

function selectAllInCurrentGroup() {
  if (SelectionState.currentGroupId) {
    const groupElement = document.querySelector(`[data-group-id="${SelectionState.currentGroupId}"]`);
    if (groupElement) {
      const tabs = groupElement.querySelectorAll('.tab-item');
      tabs.forEach(tab => {
        SelectionState.selectedTabs.add(tab);
        tab.classList.add('selected');
      });
    }
  } else if (SelectionState.allTabElements.length > 0) {
    // Select all tabs in the first group if no group is focused
    const firstGroup = document.querySelector('.group-card');
    if (firstGroup) {
      const tabs = firstGroup.querySelectorAll('.tab-item');
      tabs.forEach(tab => {
        SelectionState.selectedTabs.add(tab);
        tab.classList.add('selected');
      });
      SelectionState.currentGroupId = firstGroup.dataset.groupId;
    }
  }
}

function moveFocus(direction) {
  const tabs = SelectionState.allTabElements;
  if (tabs.length === 0) return;
  
  // Remove focus from current
  if (SelectionState.focusedIndex >= 0 && tabs[SelectionState.focusedIndex]) {
    tabs[SelectionState.focusedIndex].classList.remove('focused');
  }
  
  // Calculate new index
  let newIndex = SelectionState.focusedIndex + direction;
  if (newIndex < 0) newIndex = 0;
  if (newIndex >= tabs.length) newIndex = tabs.length - 1;
  
  SelectionState.focusedIndex = newIndex;
  
  // Add focus to new element
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
    if (SelectionState.selectedTabs.has(tab)) {
      SelectionState.selectedTabs.delete(tab);
      tab.classList.remove('selected');
    } else {
      SelectionState.selectedTabs.add(tab);
      tab.classList.add('selected');
    }
  }
}

function clearSelection() {
  SelectionState.selectedTabs.forEach(tab => tab.classList.remove('selected'));
  SelectionState.selectedTabs.clear();
  SelectionState.lastClickedIndex = -1;
}

// =============================================
// PHASE 2: Tab Click Handler with Selection Logic
// =============================================
function handleTabClick(e, tabElement, tabIndex, groupId) {
  // Don't handle if clicking on delete button or link
  if (e.target.classList.contains('tab-delete-button') || e.target.classList.contains('tab-link')) {
    return;
  }
  
  e.preventDefault();
  
  const allTabs = SelectionState.allTabElements;
  const globalIndex = allTabs.indexOf(tabElement);
  
  // Update current group context
  SelectionState.currentGroupId = groupId;
  
  if (e.shiftKey && SelectionState.lastClickedIndex >= 0) {
    // SHIFT + CLICK: Range select
    const start = Math.min(SelectionState.lastClickedIndex, globalIndex);
    const end = Math.max(SelectionState.lastClickedIndex, globalIndex);
    
    // Only select within same group
    for (let i = start; i <= end; i++) {
      if (allTabs[i] && allTabs[i].dataset.groupId === groupId) {
        SelectionState.selectedTabs.add(allTabs[i]);
        allTabs[i].classList.add('selected');
      }
    }
  } else if (e.ctrlKey || e.metaKey) {
    // CTRL/CMD + CLICK: Toggle single
    if (SelectionState.selectedTabs.has(tabElement)) {
      SelectionState.selectedTabs.delete(tabElement);
      tabElement.classList.remove('selected');
    } else {
      SelectionState.selectedTabs.add(tabElement);
      tabElement.classList.add('selected');
    }
  } else {
    // SINGLE CLICK: Select only this tab
    clearSelection();
    SelectionState.selectedTabs.add(tabElement);
    tabElement.classList.add('selected');
  }
  
  SelectionState.lastClickedIndex = globalIndex;
}

// =============================================
// PHASE 3: Soft Delete with Undo
// =============================================
function softDeleteTab(tabElement, groupId, tabIndex) {
  // Apply fade-out
  tabElement.classList.add('fade-out');
  
  // Create pending deletion record
  const deletion = {
    type: 'tab',
    element: tabElement,
    groupId: groupId,
    tabIndex: tabIndex,
    timeoutId: null
  };
  
  // Clear existing timeout if re-deleting
  const existingIndex = DeleteState.pendingDeletions.findIndex(
    d => d.element === tabElement
  );
  if (existingIndex >= 0) {
    clearTimeout(DeleteState.pendingDeletions[existingIndex].timeoutId);
    DeleteState.pendingDeletions.splice(existingIndex, 1);
  }
  
  // Set 5-second timeout
  deletion.timeoutId = setTimeout(() => {
    commitDeletion(deletion);
  }, 5000);
  
  DeleteState.pendingDeletions.push(deletion);
  
  // Show toast
  showUndoToast();
}

function softDeleteGroup(groupElement, groupId) {
  groupElement.classList.add('fade-out');
  
  const deletion = {
    type: 'group',
    element: groupElement,
    groupId: groupId,
    timeoutId: null
  };
  
  deletion.timeoutId = setTimeout(() => {
    commitDeletion(deletion);
  }, 5000);
  
  DeleteState.pendingDeletions.push(deletion);
  
  showUndoToast();
}

async function commitDeletion(deletion) {
  try {
    const groups = await getTabGroups();
    const sessionKey = await getSessionKey();
    
    if (deletion.type === 'group') {
      // Remove entire group
      const updatedGroups = groups.filter(g => g.id !== deletion.groupId);
      await saveTabGroups(updatedGroups);
      deletion.element.remove();
      
      // Show empty state if needed
      if (updatedGroups.length === 0) {
        const container = document.getElementById('groups-container');
        container.innerHTML = '<div class="empty-state"><p>No saved tabs found.</p></div>';
      }
    } else if (deletion.type === 'tab') {
      // Remove specific tab
      const groupIndex = groups.findIndex(g => g.id === deletion.groupId);
      if (groupIndex !== -1 && sessionKey) {
        const decryptedData = await decrypt(groups[groupIndex], sessionKey);
        const groupData = JSON.parse(decryptedData);
        
        groupData.tabs.splice(deletion.tabIndex, 1);
        
        if (groupData.tabs.length === 0) {
          // Remove entire group if empty
          groups.splice(groupIndex, 1);
          deletion.element.closest('.group-card')?.remove();
        } else {
          // Re-encrypt and save
          const encrypted = await encrypt(JSON.stringify(groupData), sessionKey);
          groups[groupIndex] = {
            id: deletion.groupId,
            iv: encrypted.iv,
            ciphertext: encrypted.ciphertext
          };
          deletion.element.remove();
        }
        
        await saveTabGroups(groups);
      }
    }
    
    // Remove from pending
    const index = DeleteState.pendingDeletions.indexOf(deletion);
    if (index >= 0) {
      DeleteState.pendingDeletions.splice(index, 1);
    }
    
    // Hide toast if no more pending
    if (DeleteState.pendingDeletions.length === 0) {
      hideUndoToast();
    }
  } catch (error) {
    console.error('Error committing deletion:', error);
  }
}

function undoAllDeletions() {
  DeleteState.pendingDeletions.forEach(deletion => {
    clearTimeout(deletion.timeoutId);
    deletion.element.classList.remove('fade-out');
    
    // Re-add to selection state if it was a tab
    if (deletion.type === 'tab') {
      SelectionState.selectedTabs.delete(deletion.element);
    }
  });
  
  DeleteState.pendingDeletions = [];
  hideUndoToast();
}

function showUndoToast() {
  const toast = document.getElementById('undo-toast');
  const undoButton = document.getElementById('undo-button');
  const timerSpan = document.getElementById('toast-timer');
  const messageSpan = document.getElementById('toast-message');
  
  // Update message based on pending count
  const count = DeleteState.pendingDeletions.length;
  messageSpan.textContent = count === 1 ? 'Deleted' : `${count} items deleted`;
  
  toast.classList.remove('hidden');
  
  // Remove old listener and add new one
  const newUndoButton = undoButton.cloneNode(true);
  undoButton.parentNode.replaceChild(newUndoButton, undoButton);
  newUndoButton.addEventListener('click', undoAllDeletions);
  
  // Update timer countdown
  let secondsLeft = 5;
  timerSpan.textContent = `(${secondsLeft}s)`;
  
  if (DeleteState.timerInterval) {
    clearInterval(DeleteState.timerInterval);
  }
  
  DeleteState.timerInterval = setInterval(() => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      clearInterval(DeleteState.timerInterval);
      hideUndoToast();
    } else {
      timerSpan.textContent = `(${secondsLeft}s)`;
    }
  }, 1000);
}

function hideUndoToast() {
  const toast = document.getElementById('undo-toast');
  toast.classList.add('hidden');
  if (DeleteState.timerInterval) {
    clearInterval(DeleteState.timerInterval);
  }
}

// =============================================
// PHASE 4: Restore to Private Window
// =============================================
async function restoreToPrivateWindow(urls) {
  try {
    const isAllowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!isAllowed) {
      alert('Private browsing access is not enabled. Please enable "Allow in Incognito" in Chrome extension settings.');
      return;
    }
    
    await chrome.windows.create({ url: urls, incognito: true });
  } catch (error) {
    console.error('Error opening private window:', error);
    alert(`Failed to open private window: ${error.message}`);
  }
}

// =============================================
// Render Page (PHASE 6: Staggered Animation)
// =============================================
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
    
    // Process each group
    for (let groupIndex = 0; groupIndex < encryptedGroups.length; groupIndex++) {
      const group = encryptedGroups[groupIndex];
      try {
        const decryptedData = await decrypt(group, key);
        const groupData = JSON.parse(decryptedData);
        
        // PHASE 6: Pass groupIndex for staggered animation delay
        const groupElement = createGroupElement(group.id, groupData, groupIndex);
        groupsContainer.appendChild(groupElement);
      } catch (error) {
        console.error(`Failed to decrypt group ${group.id}:`, error);
      }
    }
    
    loadingMessage.classList.add('hidden');
    groupsContainer.classList.remove('hidden');
  } catch (error) {
    console.error('Error rendering page:', error);
    loadingMessage.innerHTML = '<p class="error">Error loading saved tabs</p>';
  }
}

// =============================================
// Create Group Element (with all new features)
// =============================================
function createGroupElement(groupId, groupData, groupIndex = 0) {
  const groupElement = document.createElement('div');
  groupElement.className = 'group-card';
  groupElement.dataset.groupId = groupId;
  
  // PHASE 6: Staggered animation delay
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
    
    const favicon = tab.favIconUrl 
      ? `<img src="${tab.favIconUrl}" alt="favicon" class="favicon" onerror="this.style.display='none'">`
      : '<div class="favicon-placeholder"></div>';
    
    tabElement.innerHTML = `
      ${favicon}
      <a href="${tab.url}" target="_blank" class="tab-link">${tab.title}</a>
      <button class="tab-delete-button" data-tab-index="${tabIndex}">×</button>
    `;
    
    // PHASE 2: Add click handler for selection
    tabElement.addEventListener('click', (e) => {
      handleTabClick(e, tabElement, tabIndex, groupId);
    });
    
    // Tab delete button - PHASE 3: Soft delete
    const deleteTabButton = tabElement.querySelector('.tab-delete-button');
    deleteTabButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      softDeleteTab(tabElement, groupId, tabIndex);
    });
    
    tabsList.appendChild(tabElement);
    
    // Add to global list for keyboard navigation
    SelectionState.allTabElements.push(tabElement);
  });
  
  groupElement.appendChild(header);
  groupElement.appendChild(tabsList);
  
  // Event listeners for buttons
  const restoreButton = groupElement.querySelector('.restore-button');
  const restorePrivateButton = groupElement.querySelector('.restore-private-button');
  const exportUrlsButton = groupElement.querySelector('.export-urls-button');
  const deleteButton = groupElement.querySelector('.delete-button');
  
  // Restore All - respects "Always Private" setting
  restoreButton.addEventListener('click', async () => {
    const urls = groupData.tabs.map(tab => tab.url);
    
    if (Settings.alwaysPrivate) {
      await restoreToPrivateWindow(urls);
    } else {
      chrome.windows.create({ url: urls });
    }
  });
  
  // PHASE 4: Restore to Private Window
  restorePrivateButton.addEventListener('click', async () => {
    const urls = groupData.tabs.map(tab => tab.url);
    await restoreToPrivateWindow(urls);
  });
  
  // Export URLs
  exportUrlsButton.addEventListener('click', async () => {
    const urls = groupData.tabs.map(tab => tab.url);
    const urlsText = urls.join('\n');
    
    const blob = new Blob([urlsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `aegis-tab-urls-${new Date(groupData.date).toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    URL.revokeObjectURL(url);
  });
  
  // PHASE 3: Delete button - Soft delete
  deleteButton.addEventListener('click', () => {
    softDeleteGroup(groupElement, groupId);
  });
  
  return groupElement;
}
