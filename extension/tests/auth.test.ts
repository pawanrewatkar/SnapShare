// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAuthRedirect, pkceChallenge, getDriveAccessToken } from '@/features/authentication/auth';
import { api, ApiError, friendlyError, getSession, setSession } from '@/services/api';

const okSession = { token: 't', expiresAt: Date.now() + 3600_000, user: { id: 'u', email: 'a@b.c', name: null, avatarUrl: null } };

beforeEach(async () => {
  await chrome.storage.local.remove('session');
  await chrome.storage.session.remove('driveToken');
  vi.unstubAllGlobals();
});

describe('OAuth redirect handling', () => {
  const base = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/auth';
  it('returns the code when state matches', () => {
    expect(parseAuthRedirect(`${base}?code=abc&state=s1`, 's1')).toBe('abc');
  });
  it('rejects a state mismatch (CSRF)', () => {
    expect(() => parseAuthRedirect(`${base}?code=abc&state=evil`, 's1')).toThrow(/state mismatch/);
  });
  it('reports permission denial / cancellation', () => {
    expect(() => parseAuthRedirect(`${base}?error=access_denied&state=s1`, 's1')).toThrow(/cancelled or permission was denied/);
  });
  it('rejects a redirect without a code', () => {
    expect(() => parseAuthRedirect(`${base}?state=s1`, 's1')).toThrow(/no authorization code/);
  });
  it('computes the RFC 7636 S256 challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('API client and session handling', () => {
  it('fails fast without a session', async () => {
    await expect(api('/api/me')).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('drops expired sessions', async () => {
    await setSession({ ...okSession, expiresAt: Date.now() - 1 });
    expect(await getSession()).toBeNull();
  });
  it('clears the session when the backend says reauth is required (expired Google authorization)', async () => {
    await setSession(okSession);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'reauth_required', message: 'expired' } }), { status: 401 })));
    await expect(api('/api/me')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(await getSession()).toBeNull();
  });
  it('maps network disconnection to a friendly error', async () => {
    await setSession(okSession);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = (await api("/api/me").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('network');
    expect(friendlyError(err)).toMatch(/Network error/);
  });
  it('sends the bearer token and parses JSON', async () => {
    await setSession(okSession);
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await api('/api/me')).toEqual({ ok: 1 });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });
  it('caches the Drive access token until shortly before expiry', async () => {
    await setSession(okSession);
    const f = vi.fn(async () => new Response(JSON.stringify({ accessToken: 'ya29', expiresAt: Date.now() + 3600_000 }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await getDriveAccessToken()).toBe('ya29');
    expect(await getDriveAccessToken()).toBe('ya29');
    expect(f).toHaveBeenCalledTimes(1);
    await getDriveAccessToken(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('maps quota errors to a clear message', () => {
    expect(friendlyError(new ApiError('drive_quota', 'x', 507))).toMatch(/storage is full/);
  });
});
