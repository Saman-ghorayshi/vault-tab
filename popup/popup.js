import { 
  getCredentials, saveCredentials, getTabGroups, 
  saveTabGroups, getSessionKey, storeSessionKey 
} from '../common/storage.js';
import { 
  generateSalt, deriveKeyFromPassword, encrypt, decrypt, 
  arrayBufferToBase64, base64ToArrayBuffer 
} from '../common/crypto.js';

document.addEventListener('DOMContentLoaded', async () => {
  const lockedView = document.getElementById('locked-view');
  const unlockedView = document.getElementById('unlocked-view');
  const setupView = document.getElementById('setup-view');
  const unlockView = document.getElementById('unlock-view');
  const setupError = document.getElementById('setup-error');
  const unlockError = document.getElementById('unlock-error');
  
  const setupPassword = document.getElementById('setup-password');
  const setupPasswordConfirm = document.getElementById('setup-password-confirm');
  const setupButton = document.getElementById('setup-button');
  
  const unlockPassword = document.getElementById('unlock-password');
  const unlockButton = document.getElementById('unlock-button');
  
  const saveTabsButton = document.getElementById('save-tabs-button');
  const viewTabsButton = document.getElementById('view-tabs-button');
  
  const credentials = await getCredentials();
  
  if (!credentials) {
    setupView.classList.remove('hidden');
    setTimeout(() => setupPassword.focus(), 100);
    
    setupPassword.addEventListener('keypress', (e) => { if (e.key === 'Enter') setupPasswordConfirm.focus(); });
    setupPasswordConfirm.addEventListener('keypress', (e) => { if (e.key === 'Enter') setupButton.click(); });
    
    setupButton.addEventListener('click', async () => {
      const password = setupPassword.value;
      const confirmPassword = setupPasswordConfirm.value;
      
      setupError.classList.add('hidden');
      if (password !== confirmPassword) { setupError.textContent = 'Passwords do not match'; setupError.classList.remove('hidden'); return; }
      if (password.length < 8) { setupError.textContent = 'Password must be at least 8 characters'; setupError.classList.remove('hidden'); return; }
      
      setupButton.disabled = true;
      setupButton.textContent = 'Creating...';
      
      try {
        const salt = await generateSalt();
        const key = await deriveKeyFromPassword(password, salt);
        const verifier = await encrypt('aegis-verification-string', key);
        
        await saveCredentials({ passwordSalt: arrayBufferToBase64(salt), passwordVerifier: verifier });
        await storeSessionKey(key);
        
        lockedView.classList.add('hidden');
        unlockedView.classList.remove('hidden');
      } catch (error) {
        setupError.textContent = `Setup failed: ${error.message}`; setupError.classList.remove('hidden');
        setupButton.disabled = false; setupButton.textContent = 'Create Password';
      }
    });
  } else {
    const sessionKey = await getSessionKey();
    if (sessionKey) {
      lockedView.classList.add('hidden');
      unlockedView.classList.remove('hidden');
    } else {
      unlockView.classList.remove('hidden');
      setTimeout(() => unlockPassword.focus(), 100);
      unlockPassword.addEventListener('keypress', (e) => { if (e.key === 'Enter') unlockButton.click(); });
      
      unlockButton.addEventListener('click', async () => {
        const password = unlockPassword.value;
        unlockError.classList.add('hidden');
        if (!password) { unlockError.textContent = 'Please enter your password'; unlockError.classList.remove('hidden'); return; }
        
        unlockButton.disabled = true; unlockButton.textContent = 'Unlocking...';
        
        try {
          const salt = base64ToArrayBuffer(credentials.passwordSalt);
          const key = await deriveKeyFromPassword(password, salt);
          const decryptedVerifier = await decrypt(credentials.passwordVerifier, key);
          
          if (decryptedVerifier === 'aegis-verification-string') {
            await storeSessionKey(key);
            lockedView.classList.add('hidden');
            unlockedView.classList.remove('hidden');
          } else throw new Error('Decryption failed');
        } catch (error) {
          unlockError.textContent = 'Incorrect password'; unlockError.classList.remove('hidden');
          unlockButton.disabled = false; unlockButton.textContent = 'Unlock';
        }
      });
    }
  }
  
  saveTabsButton.addEventListener('click', async () => {
    const sessionKey = await getSessionKey();
    if (!sessionKey) {
      lockedView.classList.remove('hidden'); 
      unlockedView.classList.add('hidden'); 
      unlockView.classList.remove('hidden');
      return;
    }
    
    saveTabsButton.disabled = true; 
    saveTabsButton.textContent = 'Saving...';
    
    try {
      // 🚀 PERFORMANCE FIX: Query all tabs at once without heavy match patterns
      const originalTabs = await chrome.tabs.query({ currentWindow: true });
      
      const tabsToSave = [];
      const tabIdsToRemove = [];
      const managerUrl = chrome.runtime.getURL('manager_page/manager.html');

      for (let i = 0; i < originalTabs.length; i++) {
        const tab = originalTabs[i];
        
        // use pendingUrl if the tab is still loading and url is empty
        const targetUrl = tab.url || tab.pendingUrl;
        
        // skip invalid, system, or already open manager tabs
        if (!targetUrl || targetUrl.startsWith('chrome://') || targetUrl.startsWith('chrome-extension://')) {
          continue;
        }
        
        tabsToSave.push({
          title: tab.title || 'Loading...',
          url: targetUrl,
          favIconUrl: tab.favIconUrl || null
        });

        tabIdsToRemove.push(tab.id);
      }
      
      if (tabsToSave.length === 0) {
        alert('No saveable tabs found in this window.');
        saveTabsButton.disabled = false; 
        saveTabsButton.textContent = 'Save All Tabs';
        return;
      }
      
      // Encrypt payload
      const tabData = {
        date: new Date().toISOString(),
        tabs: tabsToSave
      };
      
      const encrypted = await encrypt(JSON.stringify(tabData), sessionKey);
      const groups = await getTabGroups();
      groups.unshift({ id: Date.now().toString(), iv: encrypted.iv, ciphertext: encrypted.ciphertext }); 
      await saveTabGroups(groups);
      
      const managerTab = await chrome.tabs.create({ url: managerUrl });
      
      const finalIdsToRemove = tabIdsToRemove.filter(id => id !== managerTab.id);
      if (finalIdsToRemove.length > 0) {
        await chrome.tabs.remove(finalIdsToRemove);
      }
      
      window.close();
    } catch (error) {
      alert(`Failed to save tabs: ${error.message}`);
      saveTabsButton.disabled = false; 
      saveTabsButton.textContent = 'Save All Tabs';
    }
  });
  viewTabsButton.addEventListener('click', async () => {
    try {
      // RESTORED PROFESSIONAL PATH
      await chrome.tabs.create({ url: chrome.runtime.getURL('manager_page/manager.html') });
      window.close();
    } catch (error) { alert(`Failed to open manager: ${error.message}`); }
  });
});