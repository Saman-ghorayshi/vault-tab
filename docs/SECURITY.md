# VaultTab Security & Cryptographic Specification

**Version:** 2.3.0  
**Compliance Standard:** OWASP Password Storage Guidelines (2024 Edition)  
**Classification:** Zero-Knowledge Client-Side Storage Architecture  

---

## 1. Executive Summary

VaultTab is an adversarial, zero-knowledge browser extension designed to protect sensitive active workspaces, developer sessions, and confidential tabs from local disk forensics, shoulder surfing, and memory snooping. 

All sensitive payloads—including session metadata, tab titles, URLs, and trained neural search vectors—are encrypted client-side using authenticated **AES-256-GCM**. No plaintext data ever touches permanent storage, telemetry services, or remote servers.

---

## 2. Threat Model & Adversarial Assumptions

| Threat Vector | Attacker Capability | Mitigation in VaultTab |
| :--- | :--- | :--- |
| **Physical Disk Forensics** | Attacker extracts local SQLite/LevelDB database files from browser profile directory while device is powered off or locked. | **Zero Plaintext at Rest:** All IndexedDB and `chrome.storage.local` entries are authenticated ciphertexts. Plaintext cannot be recovered without the user's password or hardware passkey. |
| **Shoulder Surfing / Left Unattended** | Coworker or unauthorized user accesses open laptop while user steps away. | **Configurable Auto-Lock:** Ephemeral session keys in `chrome.storage.session` are wiped automatically after an inactivity timer (5–60 minutes) or upon system sleep. |
| **Malicious Cloud Provider / MITM** | Cloud backup provider (e.g. Google Drive) or network eavesdropper inspects synced session files. | **Pre-Transport Encryption:** Vault exports (`.vaulttab`) are encrypted client-side prior to OAuth transmission. The cloud provider only ever stores authenticated binary ciphertext. |
| **Extension Cross-Context Tampering** | Neighboring extensions attempt to inspect DOM or intercept messages. | **Isolated Background Service Worker:** Key derivation and crypto execution occur exclusively within Manifest V3 background contexts and dedicated manager pages. |
| **Brute-Force & Rainbow Tables** | Attacker with GPU cluster attempts to crack stolen salt + verifier blobs. | **600,000 PBKDF2 Iterations:** Generates severe GPU memory/computation bottlenecks per OWASP 2024 guidelines. |

---

## 3. Cryptographic Implementation Details

### 3.1. Key Derivation (`PBKDF2-HMAC-SHA256`)
- **Iteration Count:** `600,000` rounds (OWASP 2024 recommended minimum for SHA-256).
- **Salt Generation:** 16 bytes of cryptographically secure pseudo-random entropy generated via `window.crypto.getRandomValues()`.
- **Key Output:** 256-bit raw key imported into Web Crypto API with `['encrypt', 'decrypt']` usage flags.

### 3.2. Authenticated Symmetric Encryption (`AES-256-GCM`)
- **Cipher:** Advanced Encryption Standard in Galois/Counter Mode (`AES-GCM`).
- **Initialization Vector (IV):** 12 bytes (96 bits), freshly generated for every single encryption operation. An IV is **never reused**.
- **Authentication Tag:** 128 bits appended to the ciphertext. Any modification of ciphertext or IV causes authenticated decryption to reject immediately.

### 3.3. Hardware Passkey Authentication (`WebAuthn / FIDO2`)
VaultTab implements raw binary parsing of WebAuthn credentials without heavy third-party dependencies:
- **Challenge Verification:** 32-byte cryptographic challenge signed by the hardware authenticator (Apple TouchID, Windows Hello, YubiKey).
- **Authenticator Data Parsing:** Extracts and asserts the `UP` (User Present) and `UV` (User Verified) bitflags from the `authenticatorData` byte slice.
- **COSE Public Key Decoding:** Decodes CBOR-encoded elliptic curve public keys (ECDSA curve P-256 / algorithm `-7`) for cryptographic assertion.

---

## 4. Ephemeral Memory Isolation

Key material lifecycle strictly adheres to the principle of least privilege:
1. **Unlock Phase:** The derived AES key exists only as a non-extractable `CryptoKey` reference inside the background service worker's `chrome.storage.session` RAM cache.
2. **Auto-Lock / Timeout:** When the auto-lock timer fires, `chrome.storage.session.clear()` is called. The `CryptoKey` reference is dropped and scheduled for immediate garbage collection.
3. **No Disk Persistence:** `chrome.storage.session` is designed by Chromium to live exclusively in RAM; it is never persisted to disk and does not survive browser restarts.

---

## 5. Local Neural Network Privacy

VaultTab includes an in-browser Word2Vec neural embedder for semantic search:
- **Local Execution:** Model training (skip-gram with negative sampling) and inference run 100% locally on the client CPU.
- **Encrypted Weights:** The vocabulary index and quantized int8 weight matrices are encrypted alongside tab data at rest.
- **Zero Telemetry:** No user search queries or tab titles are ever sent to an external API or remote model.

---

## 6. Audit & Verification

The VaultTab cryptographic test suite can be run independently using Node.js:
```bash
# Run full automated test suite (38 unit tests)
npm test
```

Verification covers:
- `test_crypto.mjs`: Vector tests, key derivation determinism, IV uniqueness, decryption tag assertion.
- `test_cose_parse.mjs`: WebAuthn attestation flag decoding, CBOR integer parsing, ECDSA key format.
- `test_embedder.mjs`: Quantized matrix dot products, vector cosine similarity ranking.
- `test_phase5.mjs`: Negative sampling stability and int8 quantization error bounds.
