# Features & status

Legend: **✅ tested** = implemented and covered by automated tests in this repo (unit / mocked / real Chromium). **🟡 unverified** = implemented but depends on Google/Supabase/OS behaviour not exercised here (needs the manual checks in TESTING.md §4). **⚠️ limited** = implemented with a documented limitation.

## Capture
| Feature | Status | Where |
| --- | --- | --- |
| Visible viewport | ✅ real Chromium | `background/capture.ts` |
| Region selection (drag, live dimensions, confirm/cancel, Enter/Esc) | ✅ real Chromium | `content/index.ts` |
| Full page: auto-scroll, stitching without duplicates, lazy-load pre-scroll, sticky/fixed hiding after first frame, scroll restore, progress, inner scroll containers, canvas-limit downscaling | ✅ real Chromium (window scrolling); inner-container path 🟡 | `background/capture.ts`, `features/screenshot/stitch.ts` |
| Entire screen / window still (Chrome picker, denial/cancel handling) | 🟡 | `pages/recorder.tsx` |
| Keyboard shortcuts (4) | 🟡 | manifest `commands` |

## Editor (Fabric.js)
| Feature | Status |
| --- | --- |
| Highlight (5 colours, multiply blend), arrow, rectangle, ellipse, text/comment (size, bold, italic, background) | ✅ real Chromium |
| Blur: destructive mosaic of underlying pixels, locked in place | ✅ pixel-verified |
| Crop, undo/redo, delete selected, clear annotations, reset, zoom/fit | ✅ |
| Colour picker + presets, stroke width, select/move/resize annotations | ✅ (move/resize via Fabric controls 🟡 manual) |
| Original preserved; edited saved as separate capture (`parentId`) | ✅ |
| Draft autosave/restore, unsaved-changes warning | 🟡 |
| Export PNG, copy edited/original, download edited/original | ✅ export; clipboard/download 🟡 |

## Recording
| Feature | Status |
| --- | --- |
| Tab recording via `tabCapture` + offscreen document (survives popup close) | 🟡 |
| Screen/window recording via `getDisplayMedia` in a recorder tab | 🟡 |
| Start/pause/resume/stop, timer, status, badge, size | ✅ state machine; UI 🟡 |
| Mic + tab/system audio mixing (AudioContext), tab audio played back to the user | 🟡 |
| Audio support matrix & warnings (macOS/Linux no screen system audio; window no audio) | ✅ logic |
| Chunks persisted every second to IndexedDB; recovery after crash / closed tab / SW restart | ✅ storage; recovery flow 🟡 |
| Tab closed, "Stop sharing", track ended, permission denial, recorder errors | 🟡 |
| WebM with duration metadata fix (≤ 512 MB) | ⚠️ larger files lack duration metadata (seek may be limited) |
| Preview, download, upload, share | 🟡 |
| Webcam overlay | ❌ not in this release (by spec); `RecorderSession` accepts extra streams later |

## Google account & Drive
| Feature | Status |
| --- | --- |
| Sign in/out, profile, session expiry, re-auth on revoked grant | ✅ mocked; 🟡 real Google |
| `drive.file` least-privilege scope | ✅ asserted in tests |
| Folder structure `SnapShare/{Screenshots,Edited Images,Videos}`, find-before-create | ✅ mocked; 🟡 real Drive |
| Resumable chunked upload, progress, retries, resume across reloads, quota & auth errors, cancel | ✅ mocked |
| Metadata in Supabase after server-side verification | ✅ mocked |
| Rename, permanent delete in Drive, storage quota display | ✅ mocked |
| Optional auto-upload after capture (Settings) | 🟡 |

## Sharing
| Feature | Status |
| --- | --- |
| Drive link generation (anyone-with-link, explicit confirm), copy, make private | ✅ mocked |
| Share with specific Google accounts (optional email) | ✅ mocked |
| SnapShare links: restricted (backend-validated) & public, expiry, revoke, download toggle, hashed tokens | ✅ |
| Public website `/s/[token]`: image, video (Range streaming), file info, download, expired/revoked/missing states | ✅ mocked + Playwright states; 🟡 real Drive streaming |
| Rate limiting on public endpoints | ✅ |
| Daily cron withdrawing Drive access of expired public links | ✅ logic; 🟡 Vercel cron |

## Gallery
All / Screenshots / Edited Images / Videos tabs, Drive + local items, thumbnails (lazy), name/type/size/date, search, source filter, preview (signed URLs), rename, download, copy image, copy share link, sharing dialog, delete (Drive file), upload local items, reconcile + "missing" state — ✅ merge logic & server operations (mocked); UI 🟡.

## Settings
Account status + sign-in/out, Drive connection & storage quota, capture defaults, editor-after-capture, sticky-header hiding, mic permission, download subfolder/pattern/save-as, default link type/expiry/download, auto-upload — 🟡 (settings persistence used throughout).

## Platform
Browser abstraction (`src/browser`) wraps tab capture, scripting, tabs, downloads, offscreen, identity, badge and storage. Remaining direct `chrome.*` use is runtime messaging/event listeners (background, offscreen, content, hooks, a few pages) plus `chrome.tabs.create` / `downloads.onChanged` in pages — these use APIs that Edge shares and Firefox exposes as `browser.*` (a polyfill or moving them behind `platform` is the next step). Edge should work with the same build (Chromium) but is untested; Firefox/Safari would need a new `BrowserPlatform` implementation plus `tabCapture`/offscreen alternatives.
