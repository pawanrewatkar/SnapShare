// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { identity } from './setup';
import { authFetch, getAccessToken, signIn, signOut, fetchProfile, refreshAccount } from '@/features/authentication/auth';
import { AuthError, friendlyError, getSession } from '@/services/api';

const profile = (sub: string, email: string) => new Response(JSON.stringify({ sub, email, name: email.split('@')[0] }), { status: 200 });

beforeEach(async () => {
  identity.token = 'tok-A';
  identity.error = null;
  identity.removed = [];
  identity.grantedScopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];
  (globalThis as unknown as { __clientId: string }).__clientId = '123-abc.apps.googleusercontent.com';
  await chrome.storage.local.remove('account');
  vi.unstubAllGlobals();
});

describe('Chrome Identity sign-in (mocked chrome.identity)', () => {
  it('requests drive.file and stores the account profile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => profile('sub-A', 'a@gmail.com')));
    const s = await signIn();
    expect(s.user).toMatchObject({ id: 'sub-A', email: 'a@gmail.com' });
    expect(identity.getAuthToken).toHaveBeenCalledWith(expect.objectContaining({ interactive: true, scopes: expect.arrayContaining(['https://www.googleapis.com/auth/drive.file']) }));
    expect((await getSession())?.user.email).toBe('a@gmail.com');
  });
  it('refuses to run without a configured OAuth client id', async () => {
    (globalThis as unknown as { __clientId: string }).__clientId = 'REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com';
    await expect(getAccessToken()).rejects.toMatchObject({ code: 'not_configured' });
  });
  it('maps cancellation / permission denied', async () => {
    identity.error = 'The user did not approve access.';
    await expect(getAccessToken(true)).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('rejects tokens without the Drive scope (granular consent unticked)', async () => {
    identity.grantedScopes = ['openid', 'email', 'profile'];
    await expect(getAccessToken(true)).rejects.toMatchObject({ code: 'scope_denied' });
    expect(identity.removed).toContain('tok-A');
  });
  it('retries once with a fresh token when Google returns 401 (expired token)', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => new Response('{}', { status: (init?.headers as Record<string, string>).Authorization === 'Bearer tok-A' ? 401 : 200 }));
    identity.getAuthToken.mockImplementationOnce(async () => ({ token: 'tok-A', grantedScopes: identity.grantedScopes })).mockImplementationOnce(async () => ({ token: 'tok-B', grantedScopes: identity.grantedScopes }));
    const res = await authFetch('https://www.googleapis.com/drive/v3/about', {}, f as unknown as typeof fetch);
    expect(res.status).toBe(200);
    expect(identity.removed).toEqual(['tok-A']);
  });
  it('signing out removes cached tokens and the stored account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => profile('sub-A', 'a@gmail.com')));
    await signIn();
    await signOut();
    expect(identity.removed).toContain('tok-A');
    expect(identity.clearAllCachedAuthTokens).toHaveBeenCalled();
    expect(await getSession()).toBeNull();
  });
  it('detects a different Google account and replaces the stored one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => profile('sub-A', 'a@gmail.com')));
    await signIn();
    vi.stubGlobal('fetch', vi.fn(async () => profile('sub-B', 'b@gmail.com')));
    await refreshAccount();
    expect((await getSession())?.user.id).toBe('sub-B');
  });
  it('profile failure is an auth error; network errors are friendly', async () => {
    await expect(fetchProfile('t', (async () => new Response('', { status: 401 })) as unknown as typeof fetch)).rejects.toBeInstanceOf(AuthError);
    expect(friendlyError(new TypeError('Failed to fetch'))).toMatch(/Network error/);
  });
});
