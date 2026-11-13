# SnapShare

Chrome extension for screenshots (visible, region, full page, screen/window), annotation, tab/screen recording and sharing — with media stored in **each user's own Google Drive** and a Next.js website for branded share links.

```
SnapShare/
├── extension/          Chrome MV3 extension (React 19, TypeScript, Vite 8, Tailwind 4, Fabric.js 6)
│   ├── manifest/       manifest.json template (API origin injected at build)
│   ├── src/background  service worker: capture orchestration, recording state machine
│   ├── src/offscreen   offscreen document: owns tab recordings (survives popup close)
│   ├── src/content     injected script: region overlay, full-page scrolling
│   ├── src/pages       popup, editor, gallery, settings, recorder (screen rec + preview), permissions
│   ├── src/features    screenshot, editor, recording, drive, gallery, sharing, authentication
│   ├── src/browser     browser-compatibility layer (all chrome.* access goes through here)
│   └── tests           Vitest unit tests + tests/e2e Playwright (real Chromium)
├── web/                Next.js 16 backend + website (API routes, /s/[token] share page)
│   ├── lib             env, crypto, auth, Google OAuth, Drive client, repositories, services
│   └── tests           unit, mocked integration, e2e (Playwright)
├── shared/             types/constants shared by extension and web
├── supabase/           migrations (schema + RLS) and an RLS verification script
├── docs/               FEATURES, SECURITY, GOOGLE_OAUTH_SETUP, CHROME_WEB_STORE_RELEASE, TESTING
├── scripts/            icon generator, extension packager
├── Memory.md           project status / hand-off notes
└── Deployment.md       production setup (Google Cloud, Supabase, Vercel, Chrome Web Store)
```

## How it fits together

- **Capture & edit** run entirely in the extension. Captures are kept locally (IndexedDB) until you upload.
- **Sign-in**: the extension opens `/api/auth/google/start` with `chrome.identity.launchWebAuthFlow`. The backend runs Google's authorization-code flow (client secret + refresh token stay server-side, encrypted), then hands the extension a one-time code redeemed with PKCE for a SnapShare session.
- **Uploads** go straight from the extension to Google Drive (resumable protocol) using a short-lived access token minted by the backend; the backend then verifies and records metadata in Supabase.
- **Sharing**: restricted links are validated by the backend (hashed token, expiry, revocation, rate limits) and the file is streamed from the owner's Drive; public links additionally enable Drive "anyone with link" after explicit confirmation.

## Requirements

- Node.js ≥ 20.9 (developed on Node 24), npm 10+
- Google Chrome ≥ 116
- For cloud features: a Google Cloud project, a Supabase project (see [Deployment.md](Deployment.md))

## Install

```bash
npm install
```

## Development

```bash
# Backend/website (http://localhost:3000)
cp web/.env.example web/.env.local      # fill in values (Deployment.md §2–4)
npm run dev -w web

# Extension (rebuilds into extension/dist on change)
cp extension/.env.example extension/.env   # VITE_API_BASE_URL=http://localhost:3000
npm run dev -w extension
```

Screenshots, the editor, clipboard, downloads and recording work **without** the backend. Google sign-in, Drive, gallery cloud items and sharing need the backend configured.

## Load the extension in Chrome

1. `npm run build -w extension`
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `extension/dist`.
4. Copy the extension ID shown on the card into `ALLOWED_EXTENSION_IDS` in `web/.env.local` and restart the web server (needed for sign-in).
5. Pin SnapShare to the toolbar. Shortcuts: `Alt+Shift+S` (default mode), `Alt+Shift+V` (visible), `Alt+Shift+R` (region), `Alt+Shift+F` (full page) — change at `chrome://extensions/shortcuts`.

> The unpacked ID depends on the folder path. To keep a stable ID across machines, add a `"key"` to `extension/manifest/manifest.json` (see docs/CHROME_WEB_STORE_RELEASE.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | TypeScript in all workspaces |
| `npm run lint` | ESLint in all workspaces |
| `npm test` | Vitest unit + mocked integration tests (extension and web) |
| `npm run build` | Production builds of extension (`extension/dist`) and web (`web/.next`) |
| `npm run test:e2e -w extension` | Builds a test extension (`dist-e2e`) and runs real-Chromium Playwright tests |
| `npm run test:e2e -w web` | Playwright tests of the website against `next dev` (in-memory repo) |
| `npm run package:extension` | Zips `extension/dist` into `release/` for the Chrome Web Store |
| `node scripts/generate-icons.mjs` | Regenerates PNG icons |

First-time Playwright setup: `npx playwright install chromium`.

See [docs/TESTING.md](docs/TESTING.md) for what each test layer does and does not prove.
