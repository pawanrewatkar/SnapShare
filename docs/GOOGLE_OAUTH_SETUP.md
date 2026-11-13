# Google OAuth & Drive setup

## Scopes (minimum required)

| Scope | Why | Google classification |
| --- | --- | --- |
| `openid`, `email`, `profile` | identify the user, show name/avatar | non-sensitive |
| `https://www.googleapis.com/auth/drive.file` | create the SnapShare folders, upload, list, rename, delete and change sharing of **files SnapShare created** | non-sensitive (per Google's scope list at time of writing — confirm in the console when adding it) |

`drive.file` supports every operation SnapShare needs because SnapShare only ever touches files it created (folders and uploads carry `appProperties.snapshare=1`). It cannot see other Drive files. Consequences to know:

- Folders/files created through a **different OAuth client** (e.g. a separate dev project) are invisible to production, so SnapShare would create new folders. Use one OAuth client per environment and don't mix data.
- If a user removes SnapShare's access in their Google account, the backend gets `invalid_grant`, marks the credential revoked and the extension asks them to sign in again.

The full `drive` scope is **not** used (it is a restricted scope requiring a security assessment).

## 1. Project & API

1. https://console.cloud.google.com → create project "SnapShare".
2. APIs & Services → Library → enable **Google Drive API**.

## 2. OAuth consent screen (Google Auth Platform)

1. Audience: **External**.
2. App information: name "SnapShare", support email, logo (120×120, must match the store listing), app home page `https://YOUR-DOMAIN`, privacy policy `https://YOUR-DOMAIN/privacy`, terms `https://YOUR-DOMAIN/terms`.
3. Authorized domains: `YOUR-DOMAIN` (must be verified in Google Search Console).
4. Data access → add scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/drive.file`.
5. While **Testing**: add test users (only they can sign in). Note: in Testing mode Google expires refresh tokens after **7 days** — users will be asked to sign in again; this goes away once published.

## 3. OAuth client

Credentials → Create credentials → OAuth client ID → **Web application** (not "Chrome extension": the backend does the code exchange so the client secret and refresh token never reach the browser).

- Authorized redirect URIs:
  - `http://localhost:3000/api/auth/google/callback` (development)
  - `https://YOUR-DOMAIN/api/auth/google/callback` (production)
- Authorized JavaScript origins: not required (no browser-side Google JS).

Copy the client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (web env only).

The extension's own redirect (`https://<extension-id>.chromiumapp.org/auth`) is **not** registered with Google — it's validated by the backend against `ALLOWED_EXTENSION_IDS`.

## 4. Flow summary

1. Extension → `GET /api/auth/google/start?redirect_uri=https://<id>.chromiumapp.org/auth&state=…&code_challenge=…` (via `chrome.identity.launchWebAuthFlow`).
2. Backend validates the extension redirect, signs a 10-minute flow-state JWT, redirects to Google with `access_type=offline`, `prompt=consent`.
3. Google → `/api/auth/google/callback`: backend exchanges the code, verifies the ID token (signature/issuer/audience), checks `drive.file` was granted (granular consent can untick it → error `drive_permission_required`), stores the refresh token AES-256-GCM encrypted, issues a 2-minute one-time code.
4. Backend redirects to the extension redirect with `code` + original `state`; the extension checks `state`, then `POST /api/auth/exchange` with the PKCE verifier → SnapShare session (30 days, revocable server-side).
5. For uploads, the extension calls `POST /api/auth/drive-token` to get a ~1 h Drive access token (owner only, never stored in the database).

## 5. Verification for production

Because only non-sensitive scopes are used, Google requires **brand verification** (not a security assessment) before the app can be published to all users:

- Verified domain ownership, home page that explains the app, privacy policy link on the home page.
- Privacy policy must describe Google user data use and the Limited Use statement (draft provided at `/privacy`; have it reviewed).
- Consent-screen logo/name match the Chrome Web Store listing.
- If Google later classifies any scope as sensitive, you'll need a demo video showing the OAuth flow and each scope's use.

Submit via Google Auth Platform → Verification Center → "Prepare for verification", then **Publish app** (Audience → In production).
