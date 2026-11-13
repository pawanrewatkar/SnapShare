# Chrome Web Store release

Do not publish automatically — every step below is manual and requires the owner's developer account.

## Pre-flight

- [ ] Web backend deployed and verified (Deployment.md §4, §7).
- [ ] `extension/.env.production` has `VITE_API_BASE_URL=https://YOUR-DOMAIN`.
- [ ] Version bumped in `extension/package.json`.
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:e2e -w extension`.
- [ ] `npm run build -w extension && npm run package:extension` → `release/snapshare-extension-<version>.zip`. The packager refuses E2E builds and warns if the API is localhost.
- [ ] Manual Chrome test pass (docs/TESTING.md §4) on the packaged build loaded unpacked.

## Stable extension ID (optional, recommended for dev)

After the first upload, the dashboard shows the item's public key (Package → "View public key"). Put it in `extension/manifest/manifest.json` as `"key": "<base64>"` for local builds so the unpacked ID matches the store ID. Remove/keep consistent for uploads (the store ignores it if it matches).

## Listing

- Name: SnapShare – Screenshot, Record & Share. Category: Productivity.
- Icons: 128×128 (`extension/public/icons/icon128.png`; replace with designed artwork), screenshots 1280×800, promo tile 440×280.
- Description must state Google Drive storage, Google sign-in requirement for cloud features, and that recordings are WebM.

## Permission justifications (paste into "Privacy practices")

| Permission | Justification |
| --- | --- |
| `activeTab` | Capture the page the user is on when they click SnapShare or press a shortcut. |
| `scripting` | Inject the region-selection overlay and scroll the page for full-page screenshots, on user action only. |
| `tabCapture` | Record the current tab when the user starts a tab recording. |
| `offscreen` | Keep tab recordings running after the popup closes (MediaRecorder in an offscreen document). |
| `storage`, `unlimitedStorage` | Settings, session, and local storage of captures/large recordings before upload. |
| `downloads` | Save screenshots and recordings to the user's Downloads folder. |
| `identity` | Google sign-in via `launchWebAuthFlow`. |
| `clipboardWrite` | Copy screenshots to the clipboard. |
| Host `https://www.googleapis.com/*` | Upload files directly to the user's Google Drive. |
| Host `https://YOUR-DOMAIN/*` | SnapShare backend API (sign-in, metadata, sharing). |

Single purpose: "Capture, annotate, record and share screenshots and screen recordings."

Remote code: **No**.

Data usage disclosures: see docs/SECURITY.md → "Chrome Web Store privacy disclosures". Privacy policy URL: `https://YOUR-DOMAIN/privacy`.

## Submit

1. https://chrome.google.com/webstore/devconsole → New item → upload zip.
2. Copy the assigned **extension ID** → add to `ALLOWED_EXTENSION_IDS` on Vercel → redeploy (sign-in fails until this is done).
3. Fill listing, privacy practices, distribution (start with "Unlisted" or a trusted-testers group).
4. Submit for review. Review may ask about `tabCapture`/`scripting` usage — the justifications above apply.
5. Google OAuth app must be **In production** (or reviewers must be test users) for reviewers to sign in. Provide a test account if requested.
