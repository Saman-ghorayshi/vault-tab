# Aegis Tab — Status Report (2026-07-08)

## What's Done

### Phase 1 — 10-bug polish (100%, committed)
Fixed: empty-state toast alignment, upload wait cursor ("learning..."), renamed
"Group Tab" → "Group Tabs" everywhere, keyboard Enter on unlock, link sharing
in popup, duplicate-group button, hover underline on group header, secondary
link styling, confirm-before-remove modal, and auto-lock timer.

### Phase 2 — Multi-user account lifecycle (100%, all committed)
- **2.1 Add Account** — setup modal with password strength meter, cancel from
  unlock view returns to unlock, duplicate-username detection.
- **2.2 Delete Account** — re-auth with password, impact preview (group count
  + model status), destructive confirmation modal.
- **2.3 Change Password** — full re-encryption of all groups and trained model
  with new key, per-step progress text, session key update.

### Phase 3 — Centralized session lifecycle (100%, committed `c10a89d`)
Service worker now owns the session key, auto-lock timer, and `aegis:locked`
broadcast. Popup and manager send `aegis:unlock` / `aegis:lock` messages
instead of writing session storage directly.

### Phase 4 — WebAuthn (≈60% coded, **uncommitted**)
- Created `common/webauthn.js` — challenge generation, assertion verification
  (ECDSA P-256 via Web Crypto), CBOR attestation parser, credential
  serialization, passkey option builders.
- Updated `background.js` — two-phase unlock (password → optional passkey),
  registration start/complete handlers, `pending_unlock` state.
- Updated `popup/popup.js` — unlock flow detects `needs_webauthn` from SW,
  triggers `navigator.credentials.get()`, sends assertion for verification.
- Updated `manager_page/manager.js` — same two-phase unlock flow, plus
  "Register Passkey" button wiring in settings.
- Updated `manager_page/manager.html` — "Register Passkey" button added.
- NOT yet committed (4 modified + 1 new file).

## What's Uncommitted Right Now

| File | Status | Lines changed |
|------|--------|--------------|
| `background.js` | modified | +154/-14 |
| `manager_page/manager.js` | modified | +78/-19 |
| `manager_page/manager.html` | modified | +1 |
| `popup/popup.js` | modified | +87/-46 |
| `common/webauthn.js` | **new** | 380 lines |

Total: 4 modified + 1 new file, 279 insertions, 41 deletions.

## What to Do Next

### Finish Phase 4 (≈40% remaining)
1. **Syntax-sweep** — `node --check` all modified files for errors.
2. **Test passkey registration** — load unpacked, unlock, click "Register
   Passkey" in manager settings, complete browser dialog, verify credential
   stored to user record.
3. **Test WebAuthn unlock** — lock the extension, unlock with password, confirm
   passkey prompt appears, complete it, verify groups load.
4. **Test password-only fallback** — for users without webauthn credential,
   unlock must skip passkey prompt entirely.
5. **Edge cases** — wrong passkey, cancelled dialog, expired challenge
   (120-second timeout), second-unlock-with-passkey-after-first-PIN-fail.
6. **Commit** — `git add -A && git commit -m "feat(webauthn): second-factor unlock with passkeys"`

### Phase 5 — Embedder upgrade (not started)
- Negative sampling improvements to the `train_context_model` algorithm.
- Weight quantization for the cosine-similarity embedder.

### Phase 6 — On-device AI (not started)
- Prompt API integration as a complementary feature for group naming.

### Phase 7 — Portfolio trust signals (not started)
- THREAT_MODEL.md documenting security boundaries.
- Automated tests for crypto, storage, and WebAuthn paths.
- CI pipeline config, manifest audit.

## Notes
- All phases are tracked in Hermes todo list.
- Phases 1-3 are committed and should work — reload unpacked in
  `chrome://extensions` to test.
- Phase 4 WebAuthn code passes `node --check` syntax validation.
- The CBOR parser in `webauthn.js` may need real-world attestation object
  testing — different authenticators produce different CBOR layouts.
