import type { ApiErrorCode } from '@snapshare/shared';
import { platform } from '@/browser';

export const API_BASE: string = __API_BASE__;

export interface Session {
  token: string;
  expiresAt: number;
  user: { id: string; email: string; name: string | null; avatarUrl: string | null };
}

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode | 'network',
    message: string,
    public status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const SESSION_KEY = 'session';

export async function getSession(): Promise<Session | null> {
  const s = await platform.storage.local.get<Session>(SESSION_KEY);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    await clearSession();
    return null;
  }
  return s;
}

export async function setSession(s: Session): Promise<void> {
  await platform.storage.local.set(SESSION_KEY, s);
}

export async function clearSession(): Promise<void> {
  await platform.storage.local.remove(SESSION_KEY);
  await platform.storage.session.remove('driveToken');
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  signal?: AbortSignal;
  raw?: boolean;
}

/** Calls the SnapShare backend. Maps HTTP/network failures to typed ApiError. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false) {
    const s = await getSession();
    if (!s) throw new ApiError('unauthenticated', 'Please sign in with Google first.', 401);
    headers.Authorization = `Bearer ${s.token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('network', 'Network error — check your connection and try again.');
  }
  if (!res.ok) {
    let code: ApiErrorCode = 'server_error';
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { code?: ApiErrorCode; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && (code === 'unauthenticated' || code === 'reauth_required')) await clearSession();
    throw new ApiError(code, message, res.status);
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Fetches an authenticated binary resource (e.g. thumbnails) and returns an object URL owned by the caller. */
export async function apiBlobUrl(path: string, signal?: AbortSignal): Promise<string> {
  const res = await api<Response>(path, { raw: true, signal });
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'unauthenticated':
        return 'Please sign in with Google to use Drive features.';
      case 'reauth_required':
        return 'Your Google authorization expired or was revoked. Please sign in again.';
      case 'drive_quota':
        return 'Your Google Drive storage is full. Free up space and try again.';
      case 'drive_missing':
        return 'This file no longer exists in Google Drive.';
      case 'rate_limited':
        return 'Too many requests. Please wait a moment.';
      default:
        return e.message;
    }
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
