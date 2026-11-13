import { SignJWT, jwtVerify } from 'jose';
import type { NextRequest } from 'next/server';
import { env } from './env';
import { repo } from './repo';
import { unauthorized } from './http';
import type { Profile } from './repo/types';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ISSUER = 'snapshare';

const key = () => new TextEncoder().encode(env().SESSION_SECRET);

/** Session JWT references a revocable server-side session row (sid). */
export async function issueSession(userId: string, userAgent: string | null): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const s = await repo().createSession(userId, expiresAt, userAgent);
  const token = await new SignJWT({ sid: s.id })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience('snapshare-extension')
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
  return { token, expiresAt: expiresAt.getTime() };
}

export interface AuthContext {
  userId: string;
  sessionId: string;
}

export async function verifySessionToken(token: string): Promise<AuthContext> {
  let sub: string | undefined;
  let sid: unknown;
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: ISSUER, audience: 'snapshare-extension', algorithms: ['HS256'] });
    sub = payload.sub;
    sid = payload.sid;
  } catch {
    throw unauthorized('Session expired. Please sign in again.');
  }
  if (!sub || typeof sid !== 'string') throw unauthorized();
  const s = await repo().getSession(sid);
  if (!s || s.userId !== sub || s.revokedAt || new Date(s.expiresAt) <= new Date()) throw unauthorized('Session expired. Please sign in again.');
  return { userId: sub, sessionId: sid };
}

export async function requireUser(req: NextRequest): Promise<AuthContext> {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9\-_.]+)$/.exec(h);
  if (!m) throw unauthorized();
  return verifySessionToken(m[1]);
}

export function publicProfile(p: Profile) {
  return { id: p.id, email: p.email, name: p.name, avatarUrl: p.avatarUrl };
}

/* ---------- OAuth flow state carried through Google (signed, short-lived) ---------- */

export interface FlowState {
  extRedirect: string;
  extState: string;
  challenge: string;
}

export async function signFlowState(s: FlowState): Promise<string> {
  return new SignJWT({ ...s }).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setAudience('oauth-flow').setIssuedAt().setExpirationTime('10m').sign(key());
}

export async function verifyFlowState(token: string): Promise<FlowState> {
  const { payload } = await jwtVerify(token, key(), { issuer: ISSUER, audience: 'oauth-flow', algorithms: ['HS256'] });
  const { extRedirect, extState, challenge } = payload as unknown as FlowState;
  if (typeof extRedirect !== 'string' || typeof extState !== 'string' || typeof challenge !== 'string') throw new Error('Invalid flow state');
  return { extRedirect, extState, challenge };
}

/** Only https://<allowed-extension-id>.chromiumapp.org/... is an acceptable redirect. */
export function isAllowedExtensionRedirect(uri: string, allowedIds: string[]): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
    const m = /^([a-p]{32})\.chromiumapp\.org$/.exec(u.hostname);
    return !!m && allowedIds.includes(m[1]);
  } catch {
    return false;
  }
}
