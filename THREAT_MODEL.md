# Aegis Tab — Threat Model

This document is written honestly. It describes what this extension
actually protects against, what it does **not** protect against, and the
known limitations. It is not a marketing page.

## What this protects against

**Casual or opportunistic local access to a locked browser profile.**

If someone picks up your laptop while Aegis Tab is locked (or you've
closed the extension and the auto-lock timer has fired), and they poke
through Chrome's extension storage files or the browser profile's
LevelDB/IndexedDB directories, they find only ciphertext. Every saved
tab title and URL is encrypted with AES-256-GCM using a key that only
exists in memory after a correct password derivation (PBKDF2-HMAC-SHA256
at 600,000 iterations). The trained semantic-search model is also
per-user and encrypted at rest. The salt and password verifier stored
on disk are not secret on their own — recovering the password from them
still requires brute-forcing through PBKDF2.

In other words: a locked Aegis Tab vault defeats the same casual-snooping
threat that full-disk encryption or an encrypted ZIP file does — someone
with brief physical access to a powered-on, locked machine cannot read
your saved tabs in cleartext.

## What this does NOT protect against

### A compromised OS or malware running with your privileges while unlocked

Once the vault is unlocked, the decrypted session key lives in the
service worker's memory, tab titles and URLs are decrypted into the
DOM, and any process running with your own user privileges can read
that memory, screenshot the page, or hook the browser. This is the same
trust boundary every browser extension has — **an unlocked vault is an
open vault.** Close the extension / let auto-lock fire when you step
away, but understand that this does not defend against a machine that is
already compromised.

### A weak, reused, or successfully phished password

PBKDF2 slows down brute force, but a password that's in a dictionary or
that you reuse across services can still be recovered from the stored
salt+verifier with enough effort. The 600,000-iteration count raises the
per-guess cost, but it does not make a bad password strong.

### A WebAuthn-only unlock, if Phase 4 was set up

The passkey / Windows Hello / Touch ID unlock is a **convenience layer**
on top of the password, not a replacement for it. It wraps the
already-derived session key with a device-bound secret so you don't
have to type the password on that device — but the password remains the
real fallback master key forever. Losing or resetting the authenticator
does not lock you out: you unlock with the password.

### Side-channel timing on username existence

We run a dummy PBKDF2 derivation on the "no such user" path so that a
wrong-username attempt takes roughly the same wall-clock time as a
wrong-password attempt for a real user. The error message is identical
either way. This makes username-enumeration via timing meaningfully
harder, but it is not a cryptographic proof of constant time — a
sophisticated attacker with many samples and tight clock control could
still attempt statistical analysis. We accept this residual risk;
perfect constant-time behavior across all code paths is out of scope
for a browser extension.

## Known limitations

### No cross-device sync

Data lives only in the local browser profile. There is no server, no
cloud sync, no account-based relay. Losing the device (or wiping the
profile) without a manual `.aegis` backup means losing the data. The
export/import backup exists precisely so you can move a vault to a new
machine — use it.

### Backups contain the salt and verifier

The `.aegis` export includes the encrypted groups **and** the account's
`password_salt`, `password_verifier`, and `password_iterations` so a
backup can be restored on a fresh install and unlocked with the original
password. A salt and a verifier are not secret on their own (recovering
the password from them still requires brute-forcing through PBKDF2), but
treating a `.aegis` file as sensitive is still correct: anyone who has it
can try passwords offline against it. Store backups somewhere sensible.

### The on-device AI summary (Phase 6) runs entirely in-browser

If the Chrome Prompt API feature is present, group summaries are
generated locally by the on-device model and never sent to a server.
No network-based AI call exists anywhere in the codebase. If the feature
is unavailable, the summarize affordance simply does not appear and
nothing else is affected.

## Not in scope (and why)

- **Protection against an attacker who controls the browser profile
  directory AND has your password.** If you have both, you have
  everything. This is true of any password-based encryption.
- **Protection against a malicious extension with broad `storage`
  permissions.** Chrome's extension model allows another installed
  extension with `storage` permission to read another extension's
  `chrome.storage.local` in some configurations. Aegis Tab encrypts at
  rest so such a reader gets ciphertext, but if that malicious extension
  is also running in your context while the vault is unlocked, the same
  in-memory-trust caveat above applies.
- **Forward secrecy / key rotation after a suspected compromise.** There
  is no re-keying protocol beyond the explicit "Change Password" flow.
  If you suspect compromise, rotate your password (which re-encrypts
  everything with a fresh key) and consider that the ciphertext you had
  before is dead weight to an attacker who already copied it.
