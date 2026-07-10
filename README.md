# Aegis Tab

A Chrome extension that securely saves, manages, and restores browser tabs using zero-knowledge AES-256-GCM encryption. No server, no cloud, no tracking — your tab data never leaves your browser.

## Features

- **Zero-knowledge encryption** — All tab data is encrypted with AES-256-GCM via the Web Crypto API. Your password is never stored; the key exists only in session memory while unlocked.
- **Multi-user accounts** — Create separate accounts, each with its own salt, verifier, and encrypted tab store. Account creation, deletion (with re-auth), and password change (with full re-encryption) are all built in.
- **WebAuthn second-factor unlock** — Register a passkey (Touch ID, Windows Hello, or security key) for fast unlock. The password path always works as a fallback — WebAuthn is a convenience layer, never a replacement.
- **On-device AI summaries** — Uses Chrome's built-in Prompt API (Gemini Nano) to generate one-line summaries of saved tab groups. Runs entirely on-device — no network call. Gracefully hidden when unavailable.
- **Neural embedding engine** — A from-scratch Word2Vec Skip-gram neural network (no libraries) that learns custom embeddings on your tab data. Provides semantic search, K-Means clustering, and a live training analytics panel with loss visualization.
- **Auto-lock** — Automatically locks the vault after inactivity. Configurable: off, 5, 10, 15, 30, or 60 minutes. Works even if only the popup is open — the service worker owns the timer via `chrome.alarms`.
- **Encrypted backup** — Export all sessions as a `.aegis` file. Import on a fresh install — the backup includes credentials so the original password still works.
- **Semantic search** — Toggle between plain text search and meaning-based search powered by the trained embedder.
- **Keyboard shortcuts** — Vim-style navigation (J/K), Gmail-style selection (X), slash to search, and more.
- **Drag-and-drop reordering** — Reorder tabs within a group. Changes persist to encrypted storage immediately.
- **Dark theme** — Clean dark UI with staggered animations.
- **Manifest V3** — Built for the latest Chrome extension platform.

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
3. Your password derives an encryption key via PBKDF2 — it is never stored

### Saving tabs
- **Global Keyboard Shortcuts (any webpage)**:
  - <kbd>Ctrl+Shift+S</kbd> (<kbd>Cmd+Shift+S</kbd> on Mac) — Instantly encrypts and saves the current tab
  - <kbd>Alt+Shift+S</kbd> — Instantly encrypts and saves all tabs in the window, then opens the manager page
  - *(Shortcuts can be customized anytime in Chrome at `chrome://extensions/shortcuts`)*
- **Save All Tabs button** — Encrypts and saves all tabs in the current window, then closes them
- **Save This Tab button** — Saves only the currently active tab
- **Right-click > Save to Aegis Tab** — Save the current page or a link via context menu

### Managing tabs & Accounts
- Create multiple isolated user accounts (`+ Add Account`) and switch between them cleanly from the lock screen dropdown
- Click **View Saved Tabs** to open the manager page
- Use **Search** to filter tabs (toggle **Semantic** for meaning-based search after training)
- Double-click a session title to rename it
- Click **Restore All** to open all tabs in a session
- Click **Incognito** to restore into a private window
- Drag tabs to reorder them within a group
- Select tabs (click, Ctrl+Click, Shift+Click) to use the floating action panel
- Click **Lock** to clear the session key and re-lock

### Keyboard shortcuts

#### Global Browser Shortcuts (any webpage)
| Key | Action |
|-----|--------|
| <kbd>Ctrl+Shift+S</kbd> (<kbd>Cmd+Shift+S</kbd>) | Save current tab to Aegis Tab |
| <kbd>Alt+Shift+S</kbd> | Save all tabs in window to Aegis Tab |

#### Manager Page Navigation
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

### Neural Embedding Engine
- Click **Train Model** in the analytics panel to train on your tab data
- Watch the loss chart decrease in real time as the model converges
- Toggle **Semantic** next to the search bar for meaning-based search
- After training, tabs get colored cluster badges showing their K-Means group
- The trained model is encrypted with your session key and stored per-user

### Settings
- **Always restore to Private window** — Toggle to always use incognito
- **Auto-lock after** — Automatically lock after inactivity (off, 5-60 min)

## Architecture

```mermaid
graph TD
    A["Master Password"] -->|PBKDF2-HMAC-SHA256 (600,000 iterations)| B["AES-256-GCM Derived Key"]
    B -->|Verify against password_verifier| C{"Verification Successful?"}
    C -->|Yes| D["Store Session Key in chrome.storage.session (RAM only)"]
    C -->|No| E["Deny Unlock"]
    
    D -->|Optional 2FA| F["WebAuthn Passkey Challenge (ECDSA / RS256)"]
    F -->|Hardware Authenticator Signs| G["Unlocked Session Active"]
    
    G -->|Encrypt / Decrypt| H["Tab Groups JSON & Neural Model"]
    H -->|AES-256-GCM Ciphertext + IV| I["chrome.storage.local / IndexedDB"]
```

```
aegis-tab/
├── manifest.json          # MV3 manifest (v2.3.0)
├── background.js          # Service worker: session lifecycle, auto-lock, context menu
├── common/
│   ├── crypto.js          # AES-256-GCM encrypt/decrypt, PBKDF2 key derivation
│   ├── storage.js          # Multi-user storage, session key, settings, model persistence
│   ├── embedder.js         # From-scratch neural network (Skip-gram + negative sampling)
│   ├── webauthn.js          # WebAuthn registration/assertion, CBOR/COSE key parsing
│   ├── idb_storage.js       # IndexedDB chunked storage fallback for large payloads
│   └── urls.js              # URL classification (restorable, system, local file)
├── popup/
│   ├── popup.html           # Extension popup UI
│   ├── popup.css            # Popup styles
│   └── popup.js             # User setup, unlock, save tabs, lock
├── manager_page/
│   ├── manager.html         # Full-page tab manager
│   ├── manager.css          # Manager styles
│   └── manager.js           # Decrypt, render, restore, search, clustering, AI summary
├── test_crypto.mjs          # crypto.js tests (11 tests)
├── test_embedder.mjs        # embedder.js tests (16 tests)
├── test_phase5.mjs          # negative sampling + quantization tests (11 tests)
├── test_cose_parse.mjs      # WebAuthn COSE/CBOR parsing regression test
├── .github/workflows/test.yml  # CI: runs all tests on push/PR (Node 18/20/22)
├── THREAT_MODEL.md          # Honest security model: what it protects, what it doesn't
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Security model

1. **Key derivation** — The master password is run through PBKDF2-HMAC-SHA256 at 600,000 iterations to derive a 256-bit AES-GCM key. Accounts created before this change used 310,000 iterations and are transparently upgraded on their next successful unlock.
2. **Verification** — A known string is encrypted with the derived key and stored as a verifier. On unlock, if decryption succeeds, the password is correct.
3. **Encryption** — Each tab session is serialized to JSON and encrypted with AES-256-GCM using a random 12-byte IV. The trained neural network model is also encrypted at rest — its vocabulary is derived from your tab data, so leaving it plaintext would leak that data.
4. **Session key** — After unlock, the raw key is exported to `chrome.storage.session`, which is cleared when the browser closes. The service worker owns the session lifecycle; auto-lock fires even if no page is open.
5. **Per-user isolation** — Each user has their own salt, verifier, tab groups, and trained model. No account can access another's data.
6. **Zero knowledge** — No plaintext tab data or model data is ever written to disk. Only ciphertext, IVs, salts, and verifiers are persisted.
7. **WebAuthn** — A passkey (Touch ID, Windows Hello, security key) can be registered as a fast unlock convenience. The password remains the real master key and always works as a fallback. The passkey does not derive the encryption key — it unlocks a locally-wrapped copy of the session key.
8. **Backup portability** — `.aegis` backup files include the salt, verifier, and iteration count so they can be restored on a fresh install. The original password still works — a salt and verifier are not secret on their own; recovering the password from them still requires brute-forcing through PBKDF2.

See [THREAT_MODEL.md](THREAT_MODEL.md) for the full security model including what this extension does and does not protect against.

### Neural Network Architecture

The embedding engine is a from-scratch Word2Vec Skip-gram implementation in pure JavaScript with zero external dependencies.

- **Architecture**: Single hidden layer (embedding lookup) with negative-sampling output
- **Negative sampling**: Instead of scoring the full vocabulary per training step, only the true context word + 10 sampled negatives are scored. Per-step cost is O(k) instead of O(vocab_size). Uses sigmoid + binary cross-entropy instead of softmax.
- **Weight quantization**: `weights_input` is quantized to int8 + one scale factor before storage (~4-5x smaller payload). `weights_output` is not persisted — it's freshly Xavier-initialized on retrain since it's only used during training, not inference.
- **Initialization**: Xavier initialization on flat Float32Array weight matrices
- **Training data**: Tab titles and URLs are tokenized into words, then skip-gram context pairs are generated with a window size of 2
- **Training loop**: Chunked with setTimeout (200 pairs per frame) to avoid blocking the UI
- **Embedding extraction**: Averages the input weight rows for all tokens in a tab's text
- **Semantic search**: Tokenizes the query, embeds it, and ranks tabs by cosine similarity
- **Clustering**: Raw K-Means with cosine distance, k=5, max 30 iterations
- **Persistence**: The trained model is encrypted with the session key and stored per-user in chrome.storage.local, with an IndexedDB chunked fallback for large payloads

All matrix math uses flat typed arrays (Float32Array) to minimize garbage collection pressure.

## Testing

No build step required. The extension runs directly from source using ES modules.

```bash
# run the automated test suites (Cryptography, WebAuthn, Embedder)
npm test
# or run individually
node --test tests/*.test.js
node --test test_crypto.mjs
node --test test_embedder.mjs
node --test test_phase5.mjs
node test_cose_parse.mjs
```

CI runs all test suites on Node 18/20/22 via GitHub Actions on every push and pull request.

## Tech stack

- Chrome Extension Manifest V3
- Vanilla JavaScript (ES modules)
- Web Crypto API (PBKDF2 + AES-256-GCM)
- WebAuthn API (navigator.credentials)
- Chrome AI API (LanguageModel / Gemini Nano)
- Chrome Storage API (local + session + IndexedDB)
- No dependencies, no build step

## Coding conventions

- Custom variables and functions use `snake_case`
- Native browser APIs (like `chrome.storage.local.get`) retain their camelCase names
- Comments are simple and direct — explain why, not what
- Zero external dependencies by design

## License

MIT — see [LICENSE](LICENSE)
