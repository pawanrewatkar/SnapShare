# Deployment

Nothing here has been deployed yet. No production URLs exist; replace `https://YOUR-DOMAIN` everywhere.

## 1. Generate secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # run 3x: SESSION_SECRET, ENCRYPTION_KEY, CRON_SECRET
```

`ENCRYPTION_KEY` encrypts Google refresh tokens and share tokens. **Rotating it invalidates stored refresh tokens (users must sign in again) and makes existing share links un-copyable** (they still resolve, because lookup uses the hash).

## 2. Google Cloud

Follow [docs/GOOGLE_OAUTH_SETUP.md](docs/GOOGLE_OAUTH_SETUP.md). Result: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, Drive API enabled, redirect URI `https://YOUR-DOMAIN/api/auth/google/callback` registered.

## 3. Supabase

1. Create a project (choose a region near your Vercel region).
2. Apply the schema — either:
   - CLI: `npx supabase login && npx supabase init` (keeps `supabase/migrations`) `&& npx supabase link --project-ref <ref> && npx supabase db push`
   - or paste `supabase/migrations/20261106000000_initial_schema.sql` into the SQL editor and run it.
3. Optional local check of RLS: `npx supabase start`, then `psql "$LOCAL_DB_URL" -f supabase/tests/rls.sql` → expect `RLS checks passed`. **Do not run it against production.**
4. Settings → API: copy the project URL (`SUPABASE_URL`) and **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`). The service key is used only by the Next.js server; never put it in the extension or any `NEXT_PUBLIC_*` variable.

## 4. Vercel (website + API)

1. Import the GitHub repo into Vercel.
2. **Root Directory**: `web`. Framework preset: Next.js. Keep "Include files outside the root directory" enabled (the `shared/` workspace is needed).
3. Environment variables (Production, and Preview if used):

| Variable | Value |
| --- | --- |
| `APP_BASE_URL` | `https://YOUR-DOMAIN` (no trailing slash) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from step 2 |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | from step 3 |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | from step 1 |
| `ALLOWED_EXTENSION_IDS` | comma-separated extension IDs (Web Store ID, plus dev IDs if wanted) |
| `CRON_SECRET` | from step 1 (Vercel sends it as `Authorization: Bearer …` to cron routes) |

4. Deploy. `web/vercel.json` schedules `/api/cron/expire-shares` daily at 03:00 UTC (deactivates expired links and withdraws Drive public access they granted).
5. Add the custom domain; then make sure `APP_BASE_URL` and the Google redirect URI use it.
6. Verify: `GET https://YOUR-DOMAIN/api/health` → `{"ok":true}`; open `https://YOUR-DOMAIN/s/invalid` → "Link not found".

**Never set `SNAPSHARE_E2E_MEMORY` in any deployed environment** (it is also refused when `NODE_ENV=production`).

## 5. Production extension build

```bash
# extension/.env.production
VITE_API_BASE_URL=https://YOUR-DOMAIN
npm run build -w extension
npm run package:extension     # → release/snapshare-extension-<version>.zip
```

The build adds `https://YOUR-DOMAIN/*` to `host_permissions`. Bump `extension/package.json` `version` for each release (it is copied into the manifest).

## 6. Chrome Web Store

See [docs/CHROME_WEB_STORE_RELEASE.md](docs/CHROME_WEB_STORE_RELEASE.md). After the first upload, copy the store-assigned extension ID into `ALLOWED_EXTENSION_IDS` and redeploy the web app **before** publishing, otherwise sign-in is rejected.

## 7. Post-deploy checklist

- [ ] Sign in from the store build; confirm the consent screen shows only basic profile + "See, edit, create and delete only the specific Google Drive files you use with this app".
- [ ] Upload a screenshot, a video > 20 MB; confirm folders `SnapShare/Screenshots`, `Edited Images`, `Videos` in Drive.
- [ ] Create a restricted link; open it in a private window; revoke; reload → "revoked".
- [ ] Create a public link; confirm Drive shows "Anyone with the link"; revoke → Drive access removed.
- [ ] Delete in the gallery → file gone from Drive (and from Drive trash is not needed: deletion is permanent).
- [ ] Delete a file directly in Drive → gallery "Sync with Drive" marks it missing.
- [ ] Check Supabase: `google_credentials.refresh_token_ciphertext` is ciphertext; `share_links` has no raw tokens.

## Operational notes / limits

- Shared media is streamed through Vercel functions. Very long videos depend on browsers issuing HTTP Range requests (they do for `<video>`); a single non-range download of a multi-GB file may hit the function duration limit of your Vercel plan.
- Rate limits are stored in Postgres (`rate_limits` table, auto-pruned).
- Rolling back: redeploy a previous Vercel deployment; migrations are additive (no destructive migration exists).
