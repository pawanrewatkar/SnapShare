# Installing SnapShare (Developer mode, internal users)

## For the admin: build the ZIP

1. Do the one-time Google Cloud setup in [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md) and put the client ID in `extension/.env`.
2. Run:
   ```bash
   npm install
   npm run build
   npm run package:extension
   ```
3. Share `release/snapshare-extension-<version>.zip` with colleagues (e.g. a shared drive). It contains `manifest.json` at its root.
4. Add every colleague's Gmail address as a **Test user** in the Google Cloud console.

## For each user: install

1. Unzip the file to a permanent folder, e.g. `C:\SnapShare` or `~/SnapShare`. **Don't delete the folder** — Chrome loads the extension from it.
2. Open `chrome://extensions` → turn on **Developer mode** (top right).
3. Click **Load unpacked** → select the unzipped folder (the one containing `manifest.json`).
4. Check that the extension ID shown is `lepgoibhofiiheidakffpgglelpajjfp`.
5. Pin SnapShare (puzzle icon → pin).
6. Click SnapShare → **Sign in with Google** → pick your Gmail account → allow access. If Google shows "Google hasn't verified this app", click **Continue** (internal app in Testing mode).

**Sign-in is required before SnapShare can be used.** After installation a welcome page opens; until you sign in, the popup only shows "Sign in with Google" and captures/recording/shortcuts open the sign-in page.

After sign-in, every capture is **saved to your Drive automatically**: screenshots and edited screenshots go to `My Drive/SnapShare/Screenshots`, and recordings go to `My Drive/SnapShare/Videos`. The folders are created on first use. Everything is private until you share a file. If an upload fails (offline, Drive full), the SnapShare icon shows **!**, the capture stays on your computer, and you can retry with the upload button in the Gallery.

## Updating

Unzip the new version **over the same folder**, then press the reload icon on the SnapShare card in `chrome://extensions`. Local captures and settings are kept.

## Sharing a file

Gallery (or editor/recording preview) → **Share**:
- **Share with specific Gmail addresses**: the recipient gets viewer access to that one file only.
- **Anyone with the link**: requires a confirmation tick, and applies to that one file only.
- **Copy Drive link** copies the file's own Google Drive URL (never a folder URL).
- **Remove** / **Turn off link access** / **Revoke all sharing for this file** remove access.
- If you shared a SnapShare folder yourself in Google Drive, the dialog shows a red warning, because every file in that folder is exposed. Use **Remove from folder** to fix it.

## Limitations

- Chrome may show a "Disable developer mode extensions" reminder on startup; click **Cancel/Keep**.
- One Google account per Chrome profile. Use separate Chrome profiles for separate Gmail accounts.
- Chrome blocks capturing `chrome://` pages, the Chrome Web Store and the built-in PDF viewer.
