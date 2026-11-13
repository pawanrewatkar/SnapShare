/**
 * Account state + error helpers for the standalone (no-backend) extension.
 * The signed-in Google account is identified by its stable `sub` id; all per-account
 * caches (Drive folder ids, gallery links) are keyed by it so accounts never mix.
 */
import { platform } from '@/browser';

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface Session {
  user: AccountUser;
}

export type AuthErrorCode = 'not_configured' | 'unauthenticated' | 'cancelled' | 'scope_denied' | 'network';

export class AuthError extends Error {
  constructor(
    public code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const KEY = 'account';

export async function getSession(): Promise<Session | null> {
  const user = await platform.storage.local.get<AccountUser>(KEY);
  return user ? { user } : null;
}

export async function setSession(s: Session): Promise<void> {
  await platform.storage.local.set(KEY, s.user);
}

export async function clearSession(): Promise<void> {
  await platform.storage.local.remove(KEY);
}

export function friendlyError(e: unknown): string {
  if (e instanceof AuthError) return e.message;
  const de = e as { name?: string; code?: string; message?: string };
  if (de?.name === 'DriveError') {
    if (de.code === 'quota') return 'Your Google Drive storage is full. Free up space and try again.';
    if (de.code === 'auth') return 'Google authorization expired. Please sign in again.';
    if (de.code === 'not_found') return 'This file no longer exists in Google Drive.';
    if (de.code === 'network') return 'Network error — check your connection and try again.';
  }
  if (e instanceof TypeError && /fetch/i.test(e.message)) return 'Network error — check your connection and try again.';
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
