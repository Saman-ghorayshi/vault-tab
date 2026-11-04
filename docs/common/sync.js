// sync.js: Handles Google Drive zero-knowledge backups

export async function get_auth_token(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(friendly_auth_error(chrome.runtime.lastError));
      } else if (!token) {
        reject(new Error('Auth token could not be retrieved.'));
      } else {
        resolve(token);
      }
    });
  });
}

// chrome.identity auth errors are cryptic one-liners. map the common ones
// (bad client id, unregistered extension) to instructions that actually fix them.
function friendly_auth_error(err) {
  const msg = String(err?.message || err);
  if (/bad client id|invalid client|invalid_client|unauthorized_client/i.test(msg)) {
    return new Error(
      'Google rejected the OAuth client. Put your real OAuth client_id in manifest.json ' +
      'and add the extension ID as a Test User in Google Cloud Console (see README - Cloud Sync setup).'
    );
  }
  if (/origin|redirect/i.test(msg)) {
    return new Error(
      'OAuth redirect mismatch. Add https://<your-extension-ID>.chromiumapp.org as an ' +
      'Authorized redirect URI of the OAuth client (see README - Cloud Sync setup).'
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

// Upload the encrypted backup JSON to the user's Drive.
// Uses the 'appDataFolder' so it's hidden from the user's normal Drive view.
export async function sync_to_drive(backup_data) {
  const token = await get_auth_token(true);
  
  // 1. Check if a backup file already exists
  const queryResponse = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name="vaulttab-cloud-backup.vaulttab"&fields=files(id)', {
    headers: { Authorization: `Bearer ${token}` }
  });
  
  let existingFileId = null;
  if (queryResponse.ok) {
    const queryResult = await queryResponse.json();
    if (queryResult.files && queryResult.files.length > 0) {
      existingFileId = queryResult.files[0].id;
    }
  }

  const metadata = {
    name: 'vaulttab-cloud-backup.vaulttab',
    mimeType: 'application/json'
  };
  
  if (!existingFileId) {
    metadata.parents = ['appDataFolder'];
  }
  
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([JSON.stringify(backup_data)], { type: 'application/json' }));
  
  // 2. If it exists, PATCH to overwrite. If not, POST to create.
  const url = existingFileId 
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart&fields=id`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`;
    
  const method = existingFileId ? 'PATCH' : 'POST';

  const response = await fetch(url, {
    method: method,
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
  return result.id;
}

// Download the backup from Google Drive
export async function download_from_drive() {
  const token = await get_auth_token(true);

  // 1. Find the file in appDataFolder (order by newest first in case of accidental duplicates)
  const queryResponse = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=name="vaulttab-cloud-backup.vaulttab"&orderBy=modifiedTime desc&fields=files(id)', {
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
