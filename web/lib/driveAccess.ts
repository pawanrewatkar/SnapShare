import { decrypt } from './crypto';
import { env } from './env';
import { DriveApiError, DriveClient } from './drive';
import { GoogleAuthError, refreshAccessToken } from './google';
import { HttpError, reauth } from './http';
import { repo } from './repo';

interface CachedToken {
  token: string;
  expiresAt: number;
}
const cache = new Map<string, CachedToken>();

type TokenProvider = (userId: string) => Promise<CachedToken>;
type ClientFactory = (token: string) => DriveClient;

let clientFactory: ClientFactory = (t) => new DriveClient(t);
let tokenProviderOverride: TokenProvider | null = null;

/** Test hooks. */
export function setDriveTestHooks(h: { factory?: ClientFactory; tokenProvider?: TokenProvider | null }) {
  if (h.factory) clientFactory = h.factory;
  if (h.tokenProvider !== undefined) tokenProviderOverride = h.tokenProvider;
  cache.clear();
}

/**
 * Mints a Google access token for the user from the encrypted refresh token stored server-side.
 * Cached per server instance until ~1 minute before expiry. invalid_grant → reauth_required.
 */
export async function getUserAccessToken(userId: string): Promise<CachedToken> {
  if (tokenProviderOverride) return tokenProviderOverride(userId);
  const hit = cache.get(userId);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit;
  const cred = await repo().getRefreshToken(userId);
  if (!cred || cred.revokedAt) throw reauth();
  try {
    const t = await refreshAccessToken(decrypt(cred.ciphertext, env().ENCRYPTION_KEY));
    const entry = { token: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    cache.set(userId, entry);
    return entry;
  } catch (e) {
    if (e instanceof GoogleAuthError && e.reason === 'invalid_grant') {
      await repo().markCredentialsRevoked(userId);
      cache.delete(userId);
      throw reauth();
    }
    throw e;
  }
}

export async function driveFor(userId: string): Promise<DriveClient> {
  return clientFactory((await getUserAccessToken(userId)).token);
}

/** Converts Drive API failures into API errors the extension understands. */
export function mapDriveError(e: unknown, userId?: string): never {
  if (e instanceof DriveApiError) {
    if (e.isAuth) {
      if (userId) cache.delete(userId);
      throw reauth();
    }
    if (e.isQuota) throw new HttpError(507, 'drive_quota', 'Your Google Drive storage is full.');
    if (e.isNotFound) throw new HttpError(404, 'drive_missing', 'The file no longer exists in Google Drive.');
    if (e.status === 403 && /insufficient/i.test(e.message)) throw reauth('SnapShare is missing Google Drive permission. Please sign in again and allow Drive access.');
    if (e.status === 429 || e.reason === 'userRateLimitExceeded' || e.reason === 'rateLimitExceeded') throw new HttpError(429, 'rate_limited', 'Google Drive is rate limiting requests. Try again shortly.');
    throw new HttpError(502, 'drive_error', `Google Drive error: ${e.message}`);
  }
  throw e;
}
