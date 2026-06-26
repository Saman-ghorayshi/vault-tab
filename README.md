# Aegis Tab

A Chrome extension that securely saves, manages, and restores browser tabs using zero-knowledge AES-256-GCM encryption.

Your tab data is encrypted with a master password that never leaves your device. The encryption key is derived using PBKDF2 (310,000 iterations) and stored only in session memory while the extension is unlocked.

## Features

- **Encrypted tab sessions** - All saved tabs are encrypted with AES-256-GCM via the Web Crypto API. No server, no cloud, no tracking.
- **Master password** - A single password protects all your saved sessions. The password is never stored - only a salt and an encrypted verifier are kept locally.
- **Session key** - After unlocking, the derived key lives in `chrome.storage.session` and is cleared when the browser closes or when you lock the extension.
- **Lock** - Instantly clear the session key from the manager page to re-lock the extension.
- **Search** - Filter saved tabs by title or URL in real time.
- **Batched tab restoration** - Restore dozens of tabs without freezing the browser. Tabs are created in parallel batches.
- **Parallel decryption** - All saved groups are decrypted simultaneously with `Promise.all` for fast page loads.
- **Import and paste URLs** - Import a `.txt` file of URLs, or paste any text and have URLs auto-extracted.
- **Export URLs** - Export any session's URLs as a plain text file.
- **Keyboard shortcuts** - Vim-style navigation (J/K), Ctrl+A select all, Shift+Click range select, Delete to remove, Ctrl+Click toggle.
- **Undo** - Soft-delete with a 5-second undo window for both tabs and entire groups.
- **Private window restore** - Restore tabs into an incognito window.
- **Dark theme** - Clean dark UI with staggered animations.
- **Manifest V3** - Built for the latest Chrome extension platform.

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/YOUR_USERNAME/aegis-tab.git
   ```
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder
5. The Aegis Tab icon will appear in your toolbar

## Usage

### First run
1. Click the extension icon
2. Create a master password (minimum 8 characters)
3. Your password is used to derive an encryption key - it is never stored

### Saving tabs
1. Click **Save All Tabs** in the popup
2. All tabs in the current window are encrypted and saved as a session
3. The saved tabs are closed and the manager page opens

### Managing tabs
- Click **View Saved Tabs** to open the manager
- Use **Search** to filter tabs by title or URL
- Click **Restore All** to open all tabs in a session
- Click **Private** to restore into an incognito window
- Click **Export URLs** to download a .txt file of URLs
- Click **Delete** to remove a session (with 5s undo)
- Click **Lock** to clear the session key and re-lock the extension

### Keyboard shortcuts (manager page)
| Key | Action |
|-----|--------|
| Click | Select tab |
| Ctrl+Click | Toggle selection |
| Shift+Click | Range select |
| Delete / Backspace | Delete selected |
| Ctrl+A | Select all in group |
| J / K | Navigate down / up |
| Enter | Toggle focused selection |
| Escape | Clear selection |

## Architecture

```
tabsaver/
├── manifest.json          # MV3 manifest
├── common/
│   ├── crypto.js          # AES-256-GCM encrypt/decrypt, PBKDF2 key derivation
│   └── storage.js          # chrome.storage.local and session wrappers
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Popup styles
│   └── popup.js           # Password setup, unlock, save tabs logic
├── manager_page/
│   ├── manager.html       # Full-page tab manager
│   ├── manager.css        # Manager styles
│   └── manager.js         # Decrypt, render, restore, search, lock logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Security model

1. **Key derivation** - The master password is run through PBKDF2 with SHA-256 and 310,000 iterations to derive a 256-bit AES-GCM key.
2. **Verification** - A known string is encrypted with the derived key and stored as a verifier. On unlock, if decryption succeeds, the password is correct.
3. **Encryption** - Each tab session is serialized to JSON and encrypted with AES-256-GCM using a random 12-byte IV.
4. **Session key** - After unlock, the raw key is exported to `chrome.storage.session`, which is cleared when the browser closes.
5. **Zero knowledge** - No plaintext tab data is ever written to disk. Only ciphertext, IVs, and the salt are persisted in `chrome.storage.local`.

## Tech stack

- Chrome Extension Manifest V3
- Vanilla JavaScript (ES modules)
- Web Crypto API (PBKDF2 + AES-256-GCM)
- Chrome Storage API (local + session)
- No dependencies, no build step

## Development

No build step required. The extension runs directly from source using ES modules.

To test changes:
1. Make edits to any file
2. Go to `chrome://extensions/`
3. Click the reload button on the Aegis Tab card
4. Test the extension

### Coding conventions

- Custom variables and functions use `snake_case`
- Native browser APIs (like `chrome.storage.local.get`) retain their camelCase names
- Comments are simple and direct
- No emojis in code or UI

## License

MIT - see [LICENSE](LICENSE)

## Contributing

Contributions are welcome. Please open an issue or submit a pull request.
