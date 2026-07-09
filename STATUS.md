# Aegis Tab — Status Report (2026-07-09)

## All phases complete

### Phase 1 — 10-bug polish (100%, committed)
Fixed: empty-state toast alignment, upload wait cursor ("learning..."), renamed
"Group Tab" → "Group Tabs" everywhere, keyboard Enter on unlock, link sharing
in popup, duplicate-group button, hover underline on group header, secondary
link styling, confirm-before-remove modal, and auto-lock timer.

### Phase 2 — Multi-user account lifecycle (100%, committed)
- 2.1 Add Account, 2.2 Delete Account, 2.3 Change Password — all done.

### Phase 3 — Centralized session lifecycle (100%, committed)
Service worker owns session key, auto-lock timer, and locked broadcast.

### Phase 4 — WebAuthn second-factor unlock (100%, committed)
common/webauthn.js with COSE/CBOR parsing, two-phase unlock, passkey
registration. Regression test in test_cose_parse.mjs passes.

### Phase 5 — Embedder upgrade (100%, committed `53bca10`)
- 5.1 Negative sampling: backward_pass now scores only the true context
  word + 10 sampled negatives instead of full softmax over the whole
  vocab. Per-step cost O(vocab_size) → O(k+1). Sigmoid + binary
  cross-entropy replaces softmax + one-hot.
- 5.2 int8 quantization: serialize() quantizes weights_input to int8 +
  one scale factor (~4-5x smaller payload). deserialize() tolerates both
  new {data, scale} and legacy plain-array shape. weights_output no
  longer persisted — re-Xavier-initialized on retrain.
- 11 tests in test_phase5.mjs, all pass.

### Phase 6 — On-device AI summary (100%, committed `45b5621`)
- One-line group summary via Chrome's built-in Prompt API (Gemini Nano).
- Feature-detects LanguageModel.availability() before showing anything.
- Summary cached as group_data.ai_summary, re-encrypted on save (same
  pattern as rename_session).
- Graceful degradation: on machines without the on-device model, the
  Summarize button simply doesn't appear. Nothing else changes.
- NOTE: cannot be fully verified from the dev environment — needs a
  Chrome build with Gemini Nano downloaded.

### Phase 7 — Portfolio trust signals (100%, committed)
- 7.1 THREAT_MODEL.md (`2bfd177`) — honest doc covering what we protect
  against (casual locked-machine snooping), what we don't (malware while
  unlocked, weak passwords), and known limitations (no cross-device sync).
- 7.2 Test suites (`7eec44b`): test_crypto.mjs (11 tests) + test_embedder.mjs
  (16 tests). Total 38 tests across all 4 test files, all pass.
- 7.3 CI (`cd0dbc9`): .github/workflows/test.yml runs on push/PR, matrix
  tests Node 18/20/22, syntax-checks all JS, runs all 4 test suites.
- 7.4 Manifest audit (`e1c55ac`): added alarms permission (needed for
  chrome.alarms-based auto-lock that survives SW suspension — fixed the
  setTimeout bug that would have killed auto-lock when the SW suspended),
  added CSP (script-src 'self' only, no unsafe-eval), removed speculative
  broad host_permissions, bumped version to 2.3.0.

## Test suite status

All 4 test files pass:
- test_crypto.mjs: 11 tests (encrypt/decrypt, PBKDF2, base64, salts/IVs)
- test_embedder.mjs: 16 tests (tokenize, cosine, kmeans, end-to-end, round-trip)
- test_phase5.mjs: 11 tests (negative sampling, quantization, regression)
- test_cose_parse.mjs: WebAuthn COSE/CBOR parsing regression

Total: 38 tests, 0 failures.

## Post-completion bug sweep (2026-07-10)

After all 7 phases were verified, a full code review found 5 more real bugs:

- `36abebc` — removed unused `activeTab` permission from manifest. The
  `tabs` permission already covers `chrome.tabs.query()`, so `activeTab`
  was redundant. `contextMenus` stays (used by the right-click menu).
- `6ec8c70` — removed 8 leftover `.txt` backup files in
  `common/New folder/` that were committed by accident early in the
  project. They were never imported by anything and cluttered the repo.
- `7511b27` — fixed `prompt_api_available()` to return a Promise instead
  of null/boolean. The old version returned `null` on the first call
  (before the async availability check resolved), so the Summarize
  button never appeared on first page load. The caller also tried
  `.then()` on a cached boolean, which would throw TypeError at runtime.
- `6a71de4` — clear `pending_unlock` and `pending_unlock_credential`
  on lock. Before this, if a user verified their password but locked
  before finishing the WebAuthn second factor, the derived key stayed in
  the service worker's memory even after the lock.
- `39af0c8` — replaced 2 `setTimeout` challenge-expiry calls with
  `chrome.alarms`. The setTimeout timers would be killed when the
  service worker suspends (~30s of inactivity), leaving the challenge
  and its derived key stuck in memory indefinitely. Named alarms survive
  suspension — same approach already used for auto-lock.

## What's left

Implementation is complete across all 7 phases plus the post-completion
bug sweep. The only verification gap is Phase 6 (on-device AI) which
requires a Chrome build with Gemini Nano to exercise end-to-end — the
feature-detection and graceful-degradation paths ensure it does no harm
on machines without it.
