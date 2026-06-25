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
      lockedView.classList.remove('hidden'); unlockedView.classList.add('hidden'); unlockView.classList.remove('hidden');
      return;
    }
    
    saveTabsButton.disabled = true; saveTabsButton.textContent = 'Saving...';
    
    try {
      const originalTabs = await chrome.tabs.query({ currentWindow: true, url: ["http://*/*", "https://*/*"] });
      const validTabs = originalTabs.filter(tab => tab.status === 'complete');
      
      if (validTabs.length === 0) {
        alert('No fully loaded tabs to save. Let your tabs finish loading first!');
        saveTabsButton.disabled = false; saveTabsButton.textContent = 'Save All Tabs';
        return;
      }
      
      const tabData = {
        date: new Date().toISOString(),
        tabs: validTabs.map(tab => ({ title: tab.title || 'Untitled', url: tab.url, favIconUrl: tab.favIconUrl || null }))
      };
      
      const encrypted = await encrypt(JSON.stringify(tabData), sessionKey);
      const groups = await getTabGroups();
      groups.unshift({ id: Date.now().toString(), iv: encrypted.iv, ciphertext: encrypted.ciphertext }); 
      await saveTabGroups(groups);
      
      // RESTORED PROFESSIONAL PATH
      const managerTab = await chrome.tabs.create({ url: chrome.runtime.getURL('manager_page/manager.html') });
      
      const validTabIds = validTabs.map(tab => tab.id).filter(id => id !== managerTab.id);
      if (validTabIds.length > 0) await chrome.tabs.remove(validTabIds);
      window.close();
    } catch (error) {
      alert(`Failed to save tabs: ${error.message}`);
      saveTabsButton.disabled = false; saveTabsButton.textContent = 'Save All Tabs';
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