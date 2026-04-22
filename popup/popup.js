import { 
  getCredentials, 
  saveCredentials, 
  getTabGroups, 
  saveTabGroups, 
  getSessionKey, 
  storeSessionKey 
} from '../common/storage.js';
import { 
  generateSalt, 
  deriveKeyFromPassword, 
  encrypt, 
  decrypt, 
  arrayBufferToBase64, 
  base64ToArrayBuffer 
} from '../common/crypto.js';

document.addEventListener('DOMContentLoaded', async () => {
  const lockedView = document.getElementById('locked-view');
  const unlockedView = document.getElementById('unlocked-view');
  const setupView = document.getElementById('setup-view');
  const unlockView = document.getElementById('unlock-view');
  const setupError = document.getElementById('setup-error');
  const unlockError = document.getElementById('unlock-error');
  
  // Setup elements
  const setupPassword = document.getElementById('setup-password');
  const setupPasswordConfirm = document.getElementById('setup-password-confirm');
  const setupButton = document.getElementById('setup-button');
  
  // Unlock elements
  const unlockPassword = document.getElementById('unlock-password');
  const unlockButton = document.getElementById('unlock-button');
  
  // Unlocked elements
  const saveTabsButton = document.getElementById('save-tabs-button');
  const viewTabsButton = document.getElementById('view-tabs-button');
  
  // Check if credentials exist
  const credentials = await getCredentials();
  
  if (!credentials) {
    // First-time setup
    setupView.classList.remove('hidden');
    
    // Auto-focus on password field
    setTimeout(() => setupPassword.focus(), 100);
    
    // Add Enter key support for password fields
    setupPassword.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        setupPasswordConfirm.focus();
      }
    });
    
    setupPasswordConfirm.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        setupButton.click();
      }
    });
    
    setupButton.addEventListener('click', async () => {
      const password = setupPassword.value;
      const confirmPassword = setupPasswordConfirm.value;
      
      // Clear previous errors
      setupError.classList.add('hidden');
      
      // Validate passwords match
      if (password !== confirmPassword) {
        setupError.textContent = 'Passwords do not match';
        setupError.classList.remove('hidden');
        return;
      }
      
      if (password.length < 8) {
        setupError.textContent = 'Password must be at least 8 characters';
        setupError.classList.remove('hidden');
        return;
      }
      
      // Disable button and show loading state
      setupButton.disabled = true;
      setupButton.textContent = 'Creating...';
      
      try {
        console.log('Starting password setup...');
        
        // Generate salt and derive key
        const salt = await generateSalt();
        console.log('Salt generated');
        
        const key = await deriveKeyFromPassword(password, salt);
        console.log('Key derived');
        
        // Create password verifier
        const verifier = await encrypt('aegis-verification-string', key);
        console.log('Verifier created');
        
        // Save credentials
        const credentialsData = {
          passwordSalt: arrayBufferToBase64(salt),
          passwordVerifier: verifier
        };
        
        await saveCredentials(credentialsData);
        console.log('Credentials saved');
        
        // Store session key
        await storeSessionKey(key);
        console.log('Session key stored');
        
        // Show unlocked view
        lockedView.classList.add('hidden');
        unlockedView.classList.remove('hidden');
        
        console.log('Password setup completed successfully');
      } catch (error) {
        console.error('Password setup error:', error);
        setupError.textContent = `Setup failed: ${error.message}`;
        setupError.classList.remove('hidden');
        
        // Re-enable button
        setupButton.disabled = false;
        setupButton.textContent = 'Create Password';
      }
    });
  } else {
    // Check if already unlocked
    const sessionKey = await getSessionKey();
    
    if (sessionKey) {
      // Already unlocked
      lockedView.classList.add('hidden');
      unlockedView.classList.remove('hidden');
    } else {
      // Need to unlock
      unlockView.classList.remove('hidden');
      
      // Auto-focus on password field
      setTimeout(() => unlockPassword.focus(), 100);
      
      // Add Enter key support for unlock password
      unlockPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          unlockButton.click();
        }
      });
      
      unlockButton.addEventListener('click', async () => {
        const password = unlockPassword.value;
        
        // Clear previous errors
        unlockError.classList.add('hidden');
        
        if (!password) {
          unlockError.textContent = 'Please enter your password';
          unlockError.classList.remove('hidden');
          return;
        }
        
        // Disable button and show loading state
        unlockButton.disabled = true;
        unlockButton.textContent = 'Unlocking...';
        
        try {
          // Derive key from password and stored salt
          const salt = base64ToArrayBuffer(credentials.passwordSalt);
          const key = await deriveKeyFromPassword(password, salt);
          
          // Verify password by decrypting the verifier
          const decryptedVerifier = await decrypt(credentials.passwordVerifier, key);
          
          if (decryptedVerifier === 'aegis-verification-string') {
            // Password is correct, store session key
            await storeSessionKey(key);
            
            // Show unlocked view
            lockedView.classList.add('hidden');
            unlockedView.classList.remove('hidden');
          } else {
            throw new Error('Decryption failed');
          }
        } catch (error) {
          unlockError.textContent = 'Incorrect password';
          unlockError.classList.remove('hidden');
          console.error(error);
          
          // Re-enable button
          unlockButton.disabled = false;
          unlockButton.textContent = 'Unlock';
        }
      });
    }
  }
  
  // Save tabs button
  saveTabsButton.addEventListener('click', async () => {
    console.log('Save tabs button clicked');
    
    const sessionKey = await getSessionKey();
    
    if (!sessionKey) {
      console.log('No session key found, forcing unlock');
      // Force unlock again
      lockedView.classList.remove('hidden');
      unlockedView.classList.add('hidden');
      unlockView.classList.remove('hidden');
      return;
    }
    
    // Disable button and show loading state
    saveTabsButton.disabled = true;
    saveTabsButton.textContent = 'Saving...';
    
    try {
      console.log('Querying tabs...');
      
      // Get all tabs in current window
      const originalTabs = await chrome.tabs.query({ 
        currentWindow: true, 
        url: ["http://*/*", "https://*/*"] 
      });
      
      console.log(`Found ${originalTabs.length} tabs to save`);
      
      if (originalTabs.length === 0) {
        console.log('No valid tabs to save');
        alert('No tabs to save. Make sure you have HTTP/HTTPS tabs open.');
        
        // Re-enable button
        saveTabsButton.disabled = false;
        saveTabsButton.textContent = 'Save All Tabs';
        return;
      }
      
      // Create tab data object
      const tabData = {
        date: new Date().toISOString(),
        tabs: originalTabs.map(tab => ({
          title: tab.title || 'Untitled',
          url: tab.url,
          favIconUrl: tab.favIconUrl || null
        }))
      };
      
      console.log('Tab data prepared:', tabData);
      
      // Encrypt tab data
      const encrypted = await encrypt(JSON.stringify(tabData), sessionKey);
      console.log('Tab data encrypted');
      
      // Create new group object with unique ID
      const newGroup = {
        id: Date.now().toString(),
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      };
      
      // Get existing groups and add new one AT THE END (The deliberate bug)
      const groups = await getTabGroups();
      groups.unshift(newGroup);
      await saveTabGroups(groups);
      console.log('Tab group saved to storage');
      
      // Create the manager tab
      console.log('Creating manager tab...');
      const managerTab = await chrome.tabs.create({ 
        url: chrome.runtime.getURL('manager_page/manager.html')
      });
      console.log('Manager tab created:', managerTab.id);
      
      // Close the original tabs (except the manager tab)
      const originalTabIds = originalTabs.map(tab => tab.id).filter(id => id !== managerTab.id);
      if (originalTabIds.length > 0) {
        console.log('Closing original tabs:', originalTabIds);
        await chrome.tabs.remove(originalTabIds);
      }
      
      // Close popup
      console.log('Tab saving completed successfully');
      window.close();
    } catch (error) {
      console.error('Error saving tabs:', error);
      alert(`Failed to save tabs: ${error.message}`);
      
      // Re-enable button
      saveTabsButton.disabled = false;
      saveTabsButton.textContent = 'Save All Tabs';
    }
  });
  
  // View tabs button
  viewTabsButton.addEventListener('click', async () => {
    try {
      await chrome.tabs.create({ 
        url: chrome.runtime.getURL('manager_page/manager.html')
      });
      window.close();
    } catch (error) {
      console.error('Error opening manager page:', error);
      alert(`Failed to open manager: ${error.message}`);
    }
  });
});