/**
 * Google sign-in with the Chrome Identity API (Chrome Extension OAuth client, no backend).
 * Tokens are cached by Chrome; we never persist them. Scope: drive.file + basic profile.
 */
import { platform } from '@/browser';
import { AuthError, clearSession, getSession, setSession, type AccountUser, type Session } from '@/services/api';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPES = ['openid', 'email', 'profile', DRIVE_FILE_SCOPE];

type Listener = (user: AccountUser | null, previous: AccountUser | null) => void;
const listeners = new Set<Listener>();
export const onAccountChange = (l: Listener) => (listeners.add(l), () => listeners.delete(l));

function mapIdentityError(e: unknown): AuthError {
  const msg = String((e as Error)?.message ?? e);
  if (/did not approve|cancel|user.*(denied|closed)|canceled/i.test(msg)) return new AuthError('cancelled', 'Google sign-in was cancelled or permission was denied.');
  if (/not signed in|sign in|interactive/i.test(msg)) return new AuthError('unauthenticated', 'Please sign in with Google first.');
  if (/bad client id|invalid_client|oauth2/i.test(msg)) return new AuthError('not_configured', 'Google OAuth client is misconfigured. Check the client ID and extension ID (docs/GOOGLE_OAUTH_SETUP.md).');
  if (/network|offline|failed to fetch/i.test(msg)) return new AuthError('network', 'Network error during Google sign-in.');
  return new AuthError('unauthenticated', `Google sign-in failed: ${msg}`);
}

function requireConfigured() {
  if (!platform.oauthClientId())
    throw new AuthError('not_configured', 'Google sign-in is not configured: set VITE_GOOGLE_CLIENT_ID and rebuild (see docs/GOOGLE_OAUTH_SETUP.md).');
}

/** Returns an access token. Non-interactive by default; interactive shows Google's consent/account UI. */
export async function getAccessToken(interactive = false): Promise<string> {
  requireConfigured();
  let res;
  try {
    res = await platform.getAuthToken(interactive, SCOPES);
  } catch (e) {
    throw mapIdentityError(e);
  }
  if (res.grantedScopes && !res.grantedScopes.includes(DRIVE_FILE_SCOPE)) {
    await platform.removeCachedAuthToken(res.token).catch(() => undefined);
    throw new AuthError('scope_denied', 'SnapShare needs the Google Drive permission ("files you use with this app"). Sign in again and allow it.');
  }
  return res.token;
}

/** Fetches the Google profile for a token (OpenID userinfo). */
export async function fetchProfile(token: string, fetchFn: typeof fetch = fetch): Promise<AccountUser> {
  const res = await fetchFn('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new AuthError('unauthenticated', `Could not read your Google profile (${res.status}).`);
  const p = (await res.json()) as { sub: string; email: string; name?: string; picture?: string };
  return { id: p.sub, email: p.email, name: p.name ?? null, avatarUrl: p.picture ?? null };
}

/** Records the signed-in account and notifies listeners when the account changed (account isolation). */
export async function recordAccount(user: AccountUser): Promise<Session> {
  const prev = (await getSession())?.user ?? null;
  await setSession({ user });
  if (prev?.id !== user.id) listeners.forEach((l) => l(user, prev));
  return { user };
}

export async function signIn(): Promise<Session> {
  const token = await getAccessToken(true);
  return recordAccount(await fetchProfile(token));
}

/** Verifies the cached token still belongs to the stored account (Chrome profile account may change). */
export async function refreshAccount(): Promise<Session | null> {
  try {
    const token = await getAccessToken(false);
    return await recordAccount(await fetchProfile(token));
  } catch {
    return getSession();
  }
}

export async function signOut(): Promise<void> {
  const prev = (await getSession())?.user ?? null;
  try {
    const { token } = await platform.getAuthToken(false, SCOPES);
    await platform.removeCachedAuthToken(token);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
  } catch {
    /* no cached token */
  }
  await platform.clearAllCachedAuthTokens().catch(() => undefined);
  await clearSession();
  listeners.forEach((l) => l(null, prev));
}

export async function currentUser() {
  return (await getSession())?.user ?? null;
}

/**
 * fetch() with a Google bearer token. On 401 the cached token is evicted and the request retried once
 * (handles expired tokens transparently).
 */
export async function authFetch(url: string, init: RequestInit = {}, fetchFn: typeof fetch = fetch): Promise<Response> {
  const go = async (token: string) => fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
  let token = await getAccessToken(false);
  let res = await go(token);
  if (res.status === 401) {
    await platform.removeCachedAuthToken(token).catch(() => undefined);
    token = await getAccessToken(false);
    res = await go(token);
  }
  return res;
}

/** Kept for the upload module: returns a valid token, forcing a refresh when asked. */
export async function getDriveAccessToken(forceRefresh = false): Promise<string> {
  if (forceRefresh) {
    const { token } = await platform.getAuthToken(false, SCOPES).catch(() => ({ token: '' }));
    if (token) await platform.removeCachedAuthToken(token).catch(() => undefined);
  }
  return getAccessToken(false);
}

export function isReauthError(e: unknown): boolean {
  return e instanceof AuthError && (e.code === 'unauthenticated' || e.code === 'scope_denied');
}
