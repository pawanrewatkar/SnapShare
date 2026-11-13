# Testing

Four layers, kept separate on purpose. **Mocked tests prove our logic against fakes; they do not prove Google Drive, Google OAuth or Supabase behave as assumed.**

## 0. Standalone-mode status (2026-11-13)

| Test | Status |
| --- | --- |
| Extension unit + mocked tests (`npm test -w extension`) incl. Chrome-identity auth, folder creation/dedupe, per-account folders, file-only sharing, inherited-permission warning, gallery account isolation | **67 passed** (mocked — does not prove real Google behaviour) |
| Real Chromium (`npm run test:e2e -w extension`): capture modes + editor | **9 passed** |
| Real Google sign-in, real Drive folders/uploads | **BLOCKED** — no OAuth client ID/credentials available |
| Two-account isolation (A shares one file with B; B can't see other files/folders; revoke removes access; switching accounts doesn't mix data) | **BLOCKED** — needs two real Gmail test users. Procedure below. |

### Manual two-account procedure (run once the OAuth client exists)
1. Chrome profile A (Gmail A): sign in, upload 2 screenshots + 1 recording. Verify Drive shows `SnapShare/Screenshots` and `SnapShare/Videos` only once each.
2. Share screenshot #1 with Gmail B (Share → specific address). Folders' sharing in Drive must still show "Private".
3. Chrome profile B (Gmail B): open the copied link → the image opens. Open `https://drive.google.com/drive/folders/<A's Screenshots id>` and the other file URLs → "You need access".
4. A: Revoke → B reloads → "You need access".
5. A: enable Anyone-with-link on screenshot #2 → incognito opens it; other files still need access.
6. A: share the `Screenshots` folder manually in Drive → SnapShare's Share dialog must show the red inherited-access warning; Remove from folder → warning disappears.
7. In profile B's SnapShare gallery, none of A's files or local uploads appear.

## 1. Unit tests (Vitest)

`npm test` (both workspaces). Last run: **extension 60 passed, web 56 passed** (web count includes the mocked integration tests in §2).

| File | Covers |
| --- | --- |
| `extension/tests/stitch.test.ts` | full-page scroll planning (no gaps/duplicates, clamped last frame, truncation), canvas size limits, region CSS→image pixel mapping |
| `extension/tests/editor.test.ts` | undo/redo stack (limit, redo invalidation, reset), arrow geometry, crop clamping, zoom steps, pixelation produces uniform opaque blocks (blur irreversibility) |
| `extension/tests/recording.test.ts` | recording state machine (start/pause/resume/stop, invalid transitions, error recovery), paused-time accounting, audio support matrix per OS, **unsupported audio combination** warnings, mic permission errors, codec selection |
| `extension/tests/auth.test.ts` | OAuth redirect parsing (state mismatch/CSRF, **permission denied**, missing code), PKCE S256 RFC vector, **expired authentication** clears session, **network disconnected**, Drive token caching |
| `extension/tests/upload.test.ts` | resumable upload against a mocked Drive server: chunking/progress, **network failure** retry + resume, max retries, **Drive quota exceeded**, 401 token refresh, expired session restart, resume from saved session, validation, cancellation |
| `extension/tests/storage.test.ts` | IndexedDB (fake-indexeddb): originals and edited versions stored separately, drafts, recording chunks ordered for crash recovery; filename/subfolder sanitising; gallery merge/filter/search |
| `web/tests/unit/crypto.test.ts` | random tokens, AES-GCM tamper detection, PKCE, signed media URLs (expired/tampered), extension redirect allow-list, upload validation, filename sanitising |
| `web/tests/unit/session.test.ts` | session issue/verify, **revoked**/forged/expired tokens, one-time auth codes (replay, expiry) |
| `web/tests/unit/shares.test.ts` | token hashing (raw token never stored), restricted vs public Drive permission, revoke removes Drive access, **invalid token**, **expired link**, **revoked link**, **missing file**, cross-user ownership, expiry cron |
| `web/tests/unit/assets.test.ts` | folder find-before-create & re-creation, registration verification (foreign/mismatched/missing files), **gallery ownership** (404 for others), rename, delete removes the Drive file + shares, reconcile **missing file** detection, Drive permission management |
| `web/tests/unit/drive.test.ts` | Drive client query escaping, 404/trashed handling, quota parsing, non-discoverable public permission; server token refresh incl. `invalid_grant` → reauth |

## 2. Mocked integration tests (Vitest)

`web/tests/integration/routes.test.ts` calls the real Next.js route handlers with an in-memory repository (`MemoryRepo`, mirrors SQL constraints) and a fake Drive. Covers 401 without session, per-user listing, 404 on foreign IDs, body validation, `reauth_required` mapping, quota mapping (507), OAuth start allow-list + scopes, PKCE exchange (wrong verifier burns the code), public streaming with Range + sandbox headers, download disabled (403), revoked → 410, no Drive IDs/emails in public metadata, IP rate limiting (429), cron secret.

## 3. Real-browser tests (Playwright, Chromium)

### Extension — `npm run test:e2e -w extension` (last run: **9 passed**)
Builds `extension/dist-e2e` (identical code, plus `<all_urls>` so captures can run without a human clicking the toolbar; the packager refuses this build) and loads it into Chromium.

- `editor.spec.ts` — real Fabric.js canvas, mouse-driven: blur export replaces pixels (stripe detail destroyed, outside untouched) and undo restores; crop changes export size, reset restores; rect/arrow/ellipse/highlight drawn into the PNG; delete/undo/redo/clear; text comment + bold/size.
- `extension.spec.ts` — popup/gallery/settings render without page errors; **visible capture** (real `captureVisibleTab`) produces a viewport-sized PNG and opens the editor; **full-page capture** on a 3060 px page: correct height, band colours at the right offsets, sticky header not repeated, scroll position restored; **region capture** via the real overlay: Esc cancels, drag + Enter yields an exact 300×200 crop; capturing `chrome://` fails with a clear message.

### Website — `npm run test:e2e -w web` (last run: **3 passed**)
Runs `next dev` with `SNAPSHARE_E2E_MEMORY=1` (seeded revoked/expired links; refused in production). Landing/privacy/terms render; share page shows not-found/revoked/expired without leaking Drive IDs or emails; `no-referrer` + `noindex` headers on `/s/*`; security headers; 401 on owner API without session.

## 4. Manual Chrome tests (required before release — not automated)

These need real Google accounts, OS pickers or audio devices. Run on Windows and macOS.

**Screenshots**
- [ ] Toolbar + each shortcut; region overlay shows dimensions; Enter/Esc; long pages with lazy images and sticky headers (e.g. a news site); pages with an inner scrolling container (e.g. Gmail-like apps); `chrome://` and Web Store pages show the clear error.
- [ ] Screen/window still: picker appears; cancel shows "cancelled or permission was denied".

**Editor / clipboard / downloads**
- [ ] Paste copied images into Slack, ClickUp and Gmail compose.
- [ ] Save → gallery shows original and edited separately; download original and edited; close tab with unsaved edits → reopen restores draft.

**Recording**
- [ ] Tab recording with tab audio + mic; close the popup → keeps recording; pause/resume timer; stop → preview plays and seeks (duration metadata).
- [ ] Mic not yet granted → permission page; deny → warning, recording continues without mic.
- [ ] Close the recorded tab mid-recording → recording stops and is saved.
- [ ] Screen recording: "Stop sharing" in Chrome's bar ends it; Windows "Share system audio" captured; macOS screen share warns no system audio.
- [ ] Close the recorder tab mid-recording → recovered recording opens ("recovered").
- [ ] Record > 10 minutes; upload > 100 MB with progress; disconnect network during upload → retry/resume.

**Google / Drive / sharing** (real external services)
- [ ] Sign in, sign out, revoke access at myaccount.google.com → next action asks to sign in again.
- [ ] Untick Drive access on Google's consent → clear "drive_permission_required" error.
- [ ] Folders created once; delete `Videos` in Drive → re-created on next upload.
- [ ] Rename/delete from gallery reflected in Drive; delete in Drive → "Sync with Drive" marks missing.
- [ ] Restricted link in a private window (image + video seek); expiry; revoke; download toggle.
- [ ] Public link toggles Drive "Anyone with the link"; revoke removes it; share with a specific email.
- [ ] Fill Drive to quota (test account) → "storage is full" message.

## 5. Real external-service tests

Not automated and **not run** in this session (no credentials available). To run against real services, use a dedicated Google test account and a non-production Supabase project, then execute §4's Google/Drive/sharing list. Do not point automated tests at production.

## Database authorization

`supabase/tests/rls.sql` impersonates two users and `anon` against a **local** Supabase (`supabase start`) and asserts row isolation, blocked cross-user share creation and unreadable credentials. Not run in this session (requires Docker + Supabase CLI).
