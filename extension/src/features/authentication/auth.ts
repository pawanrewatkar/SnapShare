import { platform } from '@/browser';
import { api, ApiError, clearSession, getSession, setSession, type Session } from '@/services/api';

function base64url(bytes: Uint8Array): string {
  let s = '';
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Parses the redirect URL returned by launchWebAuthFlow and validates the anti-CSRF state. */
export function parseAuthRedirect(redirect: string, expectedState: string): string {
  const url = new URL(redirect);
  const params = url.searchParams;
  const err = params.get('error');
  if (err) throw new Error(err === 'access_denied' ? 'Google sign-in was cancelled or permission was denied.' : `Sign-in failed: ${err}`);
  if (params.get('state') !== expectedState) throw new Error('Sign-in failed: state mismatch. Please try again.');
  const code = params.get('code');
  if (!code) throw new Error('Sign-in failed: no authorization code returned.');
  return code;
}

/**
 * Google sign-in via the SnapShare backend (authorization-code flow + PKCE between extension and backend).
 * The Google client secret and refresh token stay on the server; the extension only receives a SnapShare session.
 */
export async function signIn(): Promise<Session> {
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = await pkceChallenge(verifier);
  const redirectUri = platform.authRedirectUrl();
  const start = new URL(`${__API_BASE__}/api/auth/google/start`);
  start.searchParams.set('redirect_uri', redirectUri);
  start.searchParams.set('state', state);
  start.searchParams.set('code_challenge', challenge);
  let redirect: string;
  try {
    redirect = await platform.launchWebAuthFlow(start.toString());
  } catch (e) {
    const msg = (e as Error).message || '';
    if (/cancel|closed|did not approve/i.test(msg)) throw new Error('Sign-in was cancelled.');
    throw new Error(`Could not reach the sign-in page: ${msg}`);
  }
  const code = parseAuthRedirect(redirect, state);
  const session = await api<Session>('/api/auth/exchange', { auth: false, body: { code, code_verifier: verifier, redirect_uri: redirectUri } });
  await setSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  try {
    await api('/api/auth/signout', { method: 'POST' });
  } catch {
    /* session may already be invalid server-side */
  }
  await clearSession();
}

export async function currentUser() {
  return (await getSession())?.user ?? null;
}

interface DriveToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Returns a short-lived Google Drive access token for the signed-in user, minted by the backend from
 * the server-held refresh token. Cached in chrome.storage.session (memory only, cleared on browser exit).
 */
export async function getDriveAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await platform.storage.session.get<DriveToken>('driveToken');
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.accessToken;
  }
  const tok = await api<DriveToken>('/api/auth/drive-token', { method: 'POST' });
  await platform.storage.session.set('driveToken', tok);
  return tok.accessToken;
}

export function isReauthError(e: unknown): boolean {
  return e instanceof ApiError && (e.code === 'reauth_required' || e.code === 'unauthenticated');
}
