import { createRemoteJWKSet, jwtVerify } from 'jose';
import { GOOGLE_SCOPES } from '@snapshare/shared';
import { env } from './env';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function callbackUrl(): string {
  return `${env().APP_BASE_URL}/api/auth/google/callback`;
}

export function buildGoogleAuthUrl(state: string, loginHint?: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', env().GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', callbackUrl());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline'); // refresh token, kept server-side only
  u.searchParams.set('prompt', 'consent select_account');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  if (loginHint) u.searchParams.set('login_hint', loginHint);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
  token_type: string;
}

export class GoogleAuthError extends Error {
  constructor(
    public reason: 'invalid_grant' | 'other',
    message: string,
  ) {
    super(message);
  }
}

async function tokenRequest(body: Record<string, string>, fetchFn: typeof fetch = fetch): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, client_id: env().GOOGLE_CLIENT_ID, client_secret: env().GOOGLE_CLIENT_SECRET }),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    if (json.error === 'invalid_grant') throw new GoogleAuthError('invalid_grant', 'Google grant expired or revoked');
    throw new GoogleAuthError('other', `Google token endpoint error: ${json.error ?? res.status}`);
  }
  return json;
}

export function exchangeCode(code: string, fetchFn?: typeof fetch) {
  return tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: callbackUrl() }, fetchFn);
}

export function refreshAccessToken(refreshToken: string, fetchFn?: typeof fetch) {
  return tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchFn);
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }).catch(() => undefined);
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/** Verifies the ID token signature, issuer, audience and expiry with Google's JWKS. */
export async function verifyIdToken(idToken: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, JWKS, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env().GOOGLE_CLIENT_ID });
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('ID token missing identity claims');
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

export function hasScope(scopeString: string, scope: string): boolean {
  return scopeString.split(/\s+/).includes(scope);
}
