// Live contract check for the Google Drive endpoints sync.js uses.
// Verifies: (1) the appDataFolder query syntax parses, (2) multipart upload
// accepts our exact FormData shape, (3) alt=media download round-trips.
// Usage: node test_drive_api.mjs <oauth-token>
// Get a token with the drive.file scope from OAuth Playground:
//   https://developers.google.com/oauthplayground  (Drive API v3 -> drive.file)
const token = process.argv[2];
if (!token) {
  console.error('usage: node test_drive_api.mjs <oauth-token-with-drive.file-scope>');
  process.exit(1);
}
const H = { Authorization: `Bearer ${token}` };
const NAME = 'vaulttab-cloud-backup.vaulttab';

// 1. query — same URL sync.js builds
const q = new URL('https://www.googleapis.com/drive/v3/files');
q.searchParams.set('spaces', 'appDataFolder');
q.searchParams.set('q', `name="${NAME}"`);
q.searchParams.set('fields', 'files(id)');
const qr = await fetch(q, { headers: H });
console.log('QUERY', qr.status);
if (!qr.ok) { console.error(await qr.text()); process.exit(1); }

// 2. multipart upload — same FormData shape as sync_to_drive
const metadata = { name: NAME, mimeType: 'application/json', parents: ['appDataFolder'] };
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.append('file', new Blob([JSON.stringify({ probe: Date.now() })], { type: 'application/json' }));
const ur = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
  method: 'POST', headers: H, body: form
});
console.log('UPLOAD', ur.status);
if (!ur.ok) { console.error(await ur.text()); process.exit(1); }
const { id } = await ur.json();

// 3. download — same URL as download_from_drive
const dr = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: H });
const body = await dr.json();
console.log('DOWNLOAD', dr.status, JSON.stringify(body));
if (!dr.ok || body.probe === undefined) { console.error('round-trip failed'); process.exit(1); }

// cleanup the probe file
await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE', headers: H });
console.log('ALL-OK: query + multipart upload + alt=media download all work');
