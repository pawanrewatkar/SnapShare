# Security & privacy design

## Secrets & tokens

| Item | Where it lives | Protection |
| --- | --- | --- |
| Google client secret | Vercel env (`GOOGLE_CLIENT_SECRET`) | never shipped to the extension |
| Google refresh token | `google_credentials.refresh_token_ciphertext` | AES-256-GCM (`ENCRYPTION_KEY`), table has RLS with no policies and privileges revoked from `anon`/`authenticated` |
| Google access token | backend memory cache; extension `chrome.storage.session` (memory-only) | issued only to the authenticated owner via `POST /api/auth/drive-token`; never in DB or public responses |
| SnapShare session | extension `chrome.storage.local` (access level TRUSTED_CONTEXTS) | HS256 JWT bound to a `sessions` row → revocable at sign-out; 30-day expiry |
| Share tokens | `share_links.token_hash` (SHA-256) + `token_ciphertext` (AES-GCM, so the owner can copy the link again) | raw token never stored; 256-bit random |
| Supabase service key | Vercel env only | never in extension or `NEXT_PUBLIC_*` |

No secrets are committed: `.env*` is git-ignored except `.env.example` files containing placeholders.

## Authentication flow protections

- Extension redirect URI must be `https://<allowed-id>.chromiumapp.org/…` (`ALLOWED_EXTENSION_IDS`), so an attacker site can't receive codes.
- OAuth `state` round-trips through a signed, 10-minute JWT; extension verifies its own random `state` (CSRF).
- One-time codes expire in 2 minutes, are stored hashed, consumed atomically before PKCE (S256) verification — a stolen code with the wrong verifier is burned.
- Google ID tokens are verified against Google JWKS (issuer, audience, expiry); unverified emails are rejected.
- `invalid_grant` on refresh → credential marked revoked, API returns `reauth_required`, extension clears session and prompts sign-in.

## Authorization

- Every owner endpoint calls `requireUser` and then `getOwnedAsset`/owner checks; foreign IDs return **404** (no existence oracle).
- Asset registration is verified against Drive: file exists, `appProperties.snapshare=1`, MIME/size match, parent is the user's SnapShare folder — a client can't attach arbitrary Drive files.
- Database: RLS enabled on every table; owner policies use `auth.uid()`; `anon` has no access; secret tables have no policies. A trigger guarantees `share_links.user_id` owns the asset. `supabase/tests/rls.sql` verifies isolation locally.
- Owner media previews use 10-minute HMAC-signed URLs (asset + user + expiry + download flag).

## Sharing

- Uploads are private by default. Nothing becomes public automatically.
- Public links / "Generate Drive link" require an explicit confirmation checkbox explaining the Drive permission change. `anyone` permissions are created with `allowFileDiscovery: false`.
- Restricted links: backend validates format → hash lookup → revoked → expired → asset exists, then streams the file; Drive file IDs and owner email are never returned to viewers.
- A secret URL is **not** identity verification. For recipient-specific access, the share dialog grants Drive reader access to specific Google accounts (Google authenticates the recipient).
- Revoking a public link removes the Drive permission it created unless another active public link still needs it; removing the Drive public permission deactivates public links. Daily cron withdraws Drive access for expired public links (Drive has no native expiry for `anyone` permissions — documented to the user in the dialog).

## Web hardening

- CSP (`frame-ancestors 'none'`, restricted sources), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`.
- `/s/*`: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`.
- Streamed media: `Content-Type` from validated metadata (PNG/JPEG/WebP/WebM only), `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, RFC 5987 `Content-Disposition`.
- Rate limits (Postgres fixed windows): auth start/exchange 20/min/IP, share page & metadata 60/min/IP, share content 300/min/IP, share creation 30/min/user, drive-token 60/min/user, reconcile 6/min/user. The limiter fails **open** on DB errors (logged) to avoid locking users out — revisit if abuse appears.
- Zod validation on all request bodies; 64 KB JSON body limit; filenames sanitised; UUID checks on path params.
- Errors are mapped to safe messages; internals are only logged server-side.

## Extension hardening

- MV3 CSP `script-src 'self'`; no remote code.
- Background only accepts messages from its own extension (`sender.id`).
- Content script is injected on demand (activeTab), runs UI in a closed-off shadow DOM, and only exposes region selection / scrolling.
- Download subfolder is sanitised against path traversal.

## Known limitations / follow-ups

- Session token in `chrome.storage.local` is readable by anyone with access to the user's Chrome profile on disk (standard for extensions).
- Rate limiting is per IP; distributed abuse would need an edge WAF.
- No server-side virus scanning (media types are restricted to images/WebM and served sandboxed).
- `ENCRYPTION_KEY` rotation requires re-encryption tooling (not implemented).

## Compliance checklists

### Privacy policy (draft at `web/app/privacy/page.tsx`)
- [ ] Fill operator name, address, contact; legal review.
- [ ] Includes Google API Services User Data Policy / Limited Use statement (present in draft).
- [ ] Describes data stored, retention, deletion request process.

### Terms of service (draft at `web/app/terms/page.tsx`)
- [ ] Fill operator details; legal review (governing law, liability).

### Chrome Web Store privacy disclosures
- Data collected: **Personally identifiable information** (name, email), **Authentication information** (Google sign-in), **Website content** (only screenshots/recordings the user takes). Not collected: health, financial, location, web history, user activity, personal communications.
- Certify: not sold to third parties; not used for unrelated purposes; not used for creditworthiness.
- Permission justifications: see docs/CHROME_WEB_STORE_RELEASE.md.

### User consent
- Microphone: requested only when the user enables it, via a dedicated permission page.
- Screen/window: Chrome's own picker every time.
- Public sharing: explicit confirmation checkbox each time.
