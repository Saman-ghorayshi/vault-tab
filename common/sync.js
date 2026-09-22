// sync.js: Handles Google Drive zero-knowledge backups

export async function get_auth_token(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else if (!token) {
        reject(new Error('Auth token could not be retrieved.'));
      } else {
        resolve(token);
      }
    });
  });
}

// Upload the encrypted backup JSON to the user's Drive.
// Uses the 'appDataFolder' so it's hidden from the user's normal Drive view.
export async function sync_to_drive(backup_data) {
  const token = await get_auth_token(true);
  
  const metadata = {
    name: 'vaulttab-cloud-backup.vaulttab',
    mimeType: 'application/json',
    parents: ['appDataFolder'] // Hidden from standard Drive UI, only accessible by this app
  };
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(backup_data)], { type: 'application/json' }));
  
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Drive sync failed: ${response.status} ${errText}`);
  }

  const result = await response.json();
  return result.id; // The Google Drive File ID
}

// Download the backup from Google Drive
export async function download_from_drive() {
  const token = await get_auth_token(true);

  // 1. Find the file in appDataFolder
  const queryResponse = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name="vaulttab-cloud-backup.vaulttab"&fields=files(id)', {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!queryResponse.ok) throw new Error('Failed to query Drive.');
  
  const queryResult = await queryResponse.json();
  if (!queryResult.files || queryResult.files.length === 0) {
    throw new Error('No cloud backup found.');
  }

  const fileId = queryResult.files[0].id;

  // 2. Download the file contents
  const downloadResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!downloadResponse.ok) throw new Error('Failed to download backup from Drive.');
  
  const backup_data = await downloadResponse.json();
  return backup_data;
}
