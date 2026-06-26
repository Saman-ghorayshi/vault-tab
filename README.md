# Aegis Tab

A Chrome extension that securely saves, manages, and restores browser tabs using zero-knowledge AES-256-GCM encryption.

Your tab data is encrypted with a master password that never leaves your device. The encryption key is derived using PBKDF2 (310,000 iterations) and stored only in session memory while the extension is unlocked.

## Features

- **Multi-user support** - Create multiple user accounts, each with their own encrypted tab store. A dropdown lets you pick which user to unlock as. Useful for shared computers or separating work and personal tabs.
- **Encrypted tab sessions** - All saved tabs are encrypted with AES-256-GCM via the Web Crypto API. No server, no cloud, no tracking.
- **Master password with strength meter** - A password strength meter shows Weak/Medium/Strong as you type. Show/hide toggle on every password field.
- **Auto-lock timer** - Automatically lock the extension after a period of inactivity. Configurable: off, 5, 10, 15, 30, or 60 minutes.
- **Right-click context menu** - Right-click anywhere on a page and select "Save to Aegis Tab" to save it instantly. Right-click a link to save just the link.
- **Session rename** - Double-click any session title to give it a custom name instead of just the date.
- **Lock** - Instantly clear the session key from the manager page to re-lock the extension. Hides all UI until unlocked again.
- **Search** - Filter saved tabs by title or URL in real time.
- **Floating action panel** - When you select tabs, a panel slides in from the right edge with Open, Delete, Export, and Clear buttons. No scrolling needed.
- **Drag-and-drop reordering** - Drag tabs to reorder them within a group. Changes are persisted to encrypted storage immediately.
- **Keyboard shortcuts** - Vim-style navigation (J/K), Gmail-style selection (X), slash to search, and more. Press ? for a full guide.
- **Encrypted backup export/import** - Export all sessions as a .aegis file. Import on another machine. Contains ciphertext only.
- **Batched tab restoration** - Restore dozens of tabs without freezing the browser. Tabs are created in parallel batches.
- **Parallel decryption** - All sessions are decrypted simultaneously with Promise.all for fast page loads.
- **Import and paste URLs** - Import a .txt file of URLs, or paste any text and have URLs auto-extracted.
- **Export URLs** - Export any session's URLs as a plain text file.
- **Undo with progress bar** - Soft-delete with an 8-second undo window. Visual progress bar and smart messaging.
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
2. Enter a username and password (minimum 8 characters)
3. Your password is used to derive an encryption key - it is never stored

### Saving tabs
- **Save All Tabs** - Encrypts and saves all tabs in the current window, then closes them
- **Save This Tab** - Saves only the currently active tab
- **Right-click > Save to Aegis Tab** - Save the current page or a link via context menu

### Managing tabs
- Click **View Saved Tabs** to open the manager
- Use **Search** to filter tabs by title or URL
- Double-click a session title to rename it
- Click **Restore All** to open all tabs in a session
- Click **Private** to restore into an incognito window
- Drag tabs to reorder them within a group
- Select tabs (click, Ctrl+Click, Shift+Click) to use the floating action panel
- Click **Lock** to clear the session key and re-lock

### Keyboard shortcuts (manager page)

| Key | Action |
|-----|--------|
| J | Move focus down |
| K | Move focus up |
| Space / Enter | Toggle selection on focused tab |
| X | Select focused tab and move to next |
| O | Open selected tabs (or focused tab) |
| / | Focus the search bar |
| Del / Backspace | Delete selected tabs |
| Ctrl+A | Select all tabs in current group |
| Esc | Clear selection / close modal |
| ? | Open shortcuts guide |

Press **?** on the manager page to see the full guide as an overlay.

### Settings
- **Always restore to Private window** - Toggle to always use incognito
- **Auto-lock after** - Automatically lock after inactivity (off, 5-60 min)

## Architecture

```
aegis-tab/
├── manifest.json          # MV3 manifest (v2.1.0)
├── background.js           # Service worker: context menu to save tabs
├── common/
│   ├── crypto.js           # AES-256-GCM encrypt/decrypt, PBKDF2 key derivation
│   └── storage.js          # Multi-user storage, session key, settings
├── popup/
│   ├── popup.html          # Extension popup UI
│   ├── popup.css           # Popup styles
│   └── popup.js            # User setup, unlock, save tabs logic
├── manager_page/
│   ├── manager.html        # Full-page tab manager
│   ├── manager.css         # Manager styles
│   └── manager.js          # Decrypt, render, restore, search, lock, auto-lock, rename
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
5. **Auto-lock** - Optional idle timer clears the session key after inactivity.
6. **Zero knowledge** - No plaintext tab data is ever written to disk. Only ciphertext, IVs, and the salt are persisted.
7. **Multi-user** - Each user has their own salt and verifier. Users cannot decrypt each other's tabs without the correct password.

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
