# Google OAuth setup (standalone extension, no backend)

SnapShare signs in with the **Chrome Identity API** using an OAuth client of type **Chrome Extension**. Each user stores files in **their own** Google Drive. No server, domain, Supabase or Vercel is needed.

## Values you need

| Item | Value |
| --- | --- |
| Extension ID (fixed by `extension/manifest/public-key.txt`) | `lepgoibhofiiheidakffpgglelpajjfp` |
| Scopes | `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.file` |
| OAuth client type | Chrome Extension |
| Audience | External |

The extension ID stays the same on every PC because the manifest contains a fixed public key. Do **not** regenerate it (`scripts/generate-extension-key.mjs --force`) unless you also update the OAuth client.

## Steps (one-time, by an admin)

1. https://console.cloud.google.com → create a project, e.g. `SnapShare`.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **Google Auth Platform → Branding**: app name `SnapShare`, user support email, developer contact email.
4. **Audience**: choose **External**. While the app is in **Testing**, add each colleague's Gmail address under **Test users** (up to 100). Only test users can sign in.
5. **Data access** → Add scopes: `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`, `.../auth/drive.file`. `drive.file` is non-sensitive, so no security assessment is needed.
6. **Clients → Create client** → Application type **Chrome Extension** → Item ID `lepgoibhofiiheidakffpgglelpajjfp` → Create. Copy the **Client ID** (`…apps.googleusercontent.com`). A Chrome Extension client has no client secret.
7. In the project create `extension/.env`:
   ```
   VITE_GOOGLE_CLIENT_ID=<the client ID from step 6>
   ```
8. Rebuild and package: `npm run build && npm run package:extension`. Give users the ZIP (see INSTALLATION.md).

## Testing vs. In production

- **Testing** (recommended for 10–20 internal users): works immediately for the listed test users. Google shows an "unverified app" screen; users click **Continue**. In Testing mode Google may require users to sign in again periodically.
- **In production**: removes the test-user limit. Google asks for brand verification (homepage and privacy policy URL) before the unverified screen goes away. This is not needed for internal use.

## What the scopes allow

`drive.file` lets SnapShare see, create, rename, delete and share **only files and folders that SnapShare created** in the user's Drive. It cannot read any other Drive content. Sharing is always applied to a single file ID. SnapShare never adds permissions to the `SnapShare`, `Screenshots` or `Videos` folders.

## Sign-in behaviour

- `chrome.identity.getAuthToken` uses the Google account the **Chrome profile** is signed into. To use a different Gmail account, use a different Chrome profile (each profile has separate SnapShare data).
- Expired tokens are refreshed automatically (on a 401 the cached token is dropped and re-requested).
- Sign-out removes the cached token, revokes it at Google, and clears the stored account.
- If the user unticks the Drive permission on Google's consent screen, SnapShare shows "SnapShare needs the Google Drive permission" and asks them to sign in again.

## Troubleshooting

| Message | Fix |
| --- | --- |
| "Google sign-in is not configured" | `VITE_GOOGLE_CLIENT_ID` was empty at build time → set it and rebuild. |
| `bad client id` / "OAuth client is misconfigured" | The client's Item ID must be exactly `lepgoibhofiiheidakffpgglelpajjfp`; the client type must be Chrome Extension. |
| "Access blocked: app has not completed verification" | Add the user's Gmail as a Test user (Audience page). |
| `Drive API has not been used in project` | Enable Google Drive API (step 2). |
