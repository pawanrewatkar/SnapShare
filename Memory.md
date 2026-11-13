# SnapShare — project memory / hand-off

## 2026-11-13 update — standalone mode (supersedes backend notes below for the extension)

- Extension no longer calls the backend. Auth: `chrome.identity.getAuthToken` (`features/authentication/auth.ts`), client id injected from `VITE_GOOGLE_CLIENT_ID`; fixed extension key in `extension/manifest/public-key.txt` → ID `lepgoibhofiiheidakffpgglelpajjfp` (private key in git-ignored `extension/keys/`).
- Drive client: `features/drive/driveApi.ts`; folders `SnapShare/{Screenshots,Videos}` per account (`driveFolders:<sub>` in storage.local), de-duplicated (`driveService.ts`). Edited images → Screenshots.
- Gallery lists Drive live (`galleryApi.ts`); local captures linked to another account are hidden; deleted-in-Drive → "missing".
- Sharing per file only (`features/sharing/ShareDialog.tsx`, `permissions.ts`): Gmail addresses, anyone-with-link after confirmation, copy file URL, revoke; inherited folder permissions are detected and warned.
- Tests: extension 67 unit/mocked passed, 9 real-Chromium passed. Real two-account Google Drive isolation test: **BLOCKED** (no OAuth client/credentials yet).
- `web/` and `supabase/` remain in the repo as optional legacy (branded links); not required.
- Sign-in is mandatory: popup gate, `requireSignIn()` in `background/capture.ts` guards capture/recording/shortcuts, welcome page on install (`settings.html?signin=1`).
- Auto-save to Drive always on: `maybeAutoUpload` after every capture and recording; editor Save uploads the edited image; failures → badge "!" + `lastAutoUploadError`, retry from Gallery.
- **Blocked on:** a real OAuth client ID (`VITE_GOOGLE_CLIENT_ID`). Without it, nobody can sign in and so the extension cannot be used.


_Last updated: 2026-11-06 (initial implementation session)._

## Architecture (decisions that matter)

- **Monorepo, npm workspaces**: `shared/` (types/constants, consumed as TS source), `extension/` (MV3, React 19, Vite 8 multi-entry build + separate IIFE build for the content script), `web/` (Next.js 16 App Router, Node runtime).
- **Auth**: backend-mediated Google authorization-code flow (Web OAuth client). Extension uses `chrome.identity.launchWebAuthFlow` → `/api/auth/google/start` → Google → `/api/auth/google/callback` → one-time code → `POST /api/auth/exchange` with PKCE → HS256 session JWT bound to a `sessions` row. Chosen over `chrome.identity.getAuthToken` because (a) the server needs offline access to serve restricted share links from the owner's Drive, (b) it keeps the client secret/refresh token off the client, (c) `launchWebAuthFlow` exists in Edge/Firefox.
- **Drive scope**: `drive.file` only. Folders/files carry `appProperties.snapshare=1`.
- **Uploads**: extension → Google Drive directly (resumable, 8 MiB chunks) with a backend-minted access token; then `POST /api/assets` registers metadata after server-side verification. Avoids Vercel body limits.
- **Sharing**: restricted = backend validates SHA-256 token hash/expiry/revocation and streams from Drive (Range support); public = additionally Drive `anyone` reader permission after explicit confirmation. Token ciphertext (AES-GCM) stored so the owner can copy links again.
- **Recording**: tab mode → `tabCapture.getMediaStreamId` in SW → offscreen document (`USER_MEDIA`, `AUDIO_PLAYBACK`) runs `RecorderSession`. Screen mode → `recorder.html` tab calls `getDisplayMedia` (offscreen docs can't show the picker). State machine lives in SW (`chrome.storage.session`), chunks persisted to IndexedDB every second; recovery on SW restart / host loss / browser restart.
- **Blur** is a destructive mosaic image (FabricImage of averaged pixels from the base) locked in place — export pixels are genuinely replaced.
- **Repository pattern** in `web/lib/repo`: `SupabaseRepo` (service role, explicit owner filters) and `MemoryRepo` (tests + guarded E2E mode). RLS is defence in depth.

## Completed (all build, typecheck, lint clean)

Extension: popup (sign-in/profile, 4 capture modes, recording controls with timer, recent captures, gallery/settings nav), visible/region/full-page/screen capture, editor (all tools in spec), clipboard/downloads, tab + screen recording with audio mixing, pause/resume, recovery, preview page, Google sign-in/out, Drive upload with progress/retry/resume, gallery (Drive + local, search/filter/preview/rename/download/delete/share/copy link/reconcile), share dialog (SnapShare links + Drive permissions), settings, microphone permission page, keyboard shortcuts, auto-upload option.

Web: all API routes (auth, drive folders/storage, assets CRUD + thumbnail + signed URLs + permissions + shares + reconcile, public share metadata/content, cron), share page, landing, privacy/terms drafts, security headers, Postgres rate limiting.

Database: `supabase/migrations/20261106000000_initial_schema.sql` (profiles, google_accounts, google_credentials, sessions, auth_codes, drive_folders, media_assets, share_links, activity_logs, rate_limits; FKs, indexes, uniqueness, checks, owner trigger, RLS policies, RPCs).

## Tests (last run 2026-11-06)

- `npm test`: extension 60 passed; web 56 passed (unit + mocked integration).
- `npm run test:e2e -w extension`: 9 passed (real Chromium: editor pixels; real visible/full-page/region capture through the loaded extension).
- `npm run test:e2e -w web`: 3 passed.
- Not run: real Google/Drive/Supabase tests, `supabase/tests/rls.sql`, manual recording/audio/clipboard checks (TESTING.md §4).

## Known issues / limitations

- Nothing verified against real Google OAuth, Drive or Supabase yet (no credentials in this session).
- Recording, screen still, clipboard paste targets, Drive upload of large files: implemented, manual verification pending.
- WebM duration metadata is patched only for recordings ≤ 512 MB (memory bound).
- Full-page capture of inner scroll containers is heuristic (largest scrollable element).
- Pages can't be captured: `chrome://`, Chrome Web Store, PDF viewer (Chrome restriction) — clear error shown.
- Very large shared videos stream through Vercel functions; non-Range downloads may hit plan duration limits.
- Public Drive permission has no native expiry; the daily cron removes it after link expiry (up to ~24 h lag).
- Rate limiter fails open on DB errors.
- Icons are generated placeholders; privacy/terms are drafts needing legal review and operator details.
- Some `chrome.*` calls still bypass `src/browser` (messaging/listeners) — see FEATURES.md "Platform".
- Repo initialised with `git init`; nothing committed yet.

## Next steps

1. Create Google Cloud project + OAuth client, Supabase project, Vercel deployment (Deployment.md); load the extension with `ALLOWED_EXTENSION_IDS` set; run TESTING.md §4.
2. Run `supabase/tests/rls.sql` against a local Supabase.
3. Fix anything found in manual testing (recording on macOS/Windows, Drive edge cases).
4. Design real icons/store assets; legal review of privacy/terms; Google brand verification; Chrome Web Store submission (docs/CHROME_WEB_STORE_RELEASE.md).
5. Nice-to-have: move remaining `chrome.*` calls behind `platform`, streaming WebM duration fix for large files, webcam overlay (future release), key rotation tooling.

## Key commands

```bash
npm install && npx playwright install chromium
npm run typecheck && npm run lint && npm test
npm run test:e2e -w extension && npm run test:e2e -w web
npm run build && npm run package:extension
```
