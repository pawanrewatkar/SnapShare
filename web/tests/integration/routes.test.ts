import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { issueSession } from '@/lib/auth';
import { createShare } from '@/lib/services/shares';
import { setDriveTestHooks } from '@/lib/driveAccess';
import { reauth } from '@/lib/http';
import * as assetsRoute from '@/app/api/assets/route';
import * as assetRoute from '@/app/api/assets/[id]/route';
import * as shareContent from '@/app/api/public/shares/[token]/content/route';
import * as shareMeta from '@/app/api/public/shares/[token]/route';
import * as storageRoute from '@/app/api/drive/storage/route';
import * as exchangeRoute from '@/app/api/auth/exchange/route';
import * as startRoute from '@/app/api/auth/google/start/route';
import * as cronRoute from '@/app/api/cron/expire-shares/route';
import { FakeDrive, seedAsset, seedUser, setup, silenceConsole } from '../helpers';
import type { MemoryRepo } from '@/lib/repo/memory';
import { sha256Base64Url, sha256Hex } from '@/lib/crypto';

/** Mocked integration tests: real route handlers + in-memory DB + fake Drive. They do NOT prove real Google/Supabase behaviour. */
let repo: MemoryRepo;
let drive: FakeDrive;
beforeEach(() => {
  ({ repo, drive } = setup());
});

const req = (url: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new NextRequest(`https://snapshare.test${url}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), 'x-real-ip': '1.2.3.4', ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const ctx = <P,>(p: P) => ({ params: Promise.resolve(p) });

describe('API authorization', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await assetsRoute.GET(req('/api/assets'), ctx({}));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });
  it('lists only the caller’s assets', async () => {
    const a = await seedUser(repo, 'a@example.com');
    const b = await seedUser(repo, 'b@example.com');
    await seedAsset(repo, drive, a.id);
    await seedAsset(repo, drive, b.id);
    const { token } = await issueSession(a.id, null);
    const res = await assetsRoute.GET(req('/api/assets', { token }), ctx({}));
    const list = await res.json();
    expect(list).toHaveLength(1);
  });
  it('returns 404 for another user’s asset id', async () => {
    const a = await seedUser(repo, 'a@example.com');
    const b = await seedUser(repo, 'b@example.com');
    const asset = await seedAsset(repo, drive, b.id);
    const { token } = await issueSession(a.id, null);
    expect((await assetRoute.DELETE(req(`/api/assets/${asset.id}`, { method: 'DELETE', token }), ctx({ id: asset.id }))).status).toBe(404);
    expect(drive.files.has(asset.driveFileId)).toBe(true);
  });
  it('validates request bodies', async () => {
    const a = await seedUser(repo);
    const { token } = await issueSession(a.id, null);
    const res = await assetsRoute.POST(req('/api/assets', { method: 'POST', token, body: { driveFileId: '../x', filename: '', mediaType: 'exe' } }), ctx({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation');
  });
  it('maps an expired Google grant to reauth_required', async () => {
    const a = await seedUser(repo);
    const { token } = await issueSession(a.id, null);
    setDriveTestHooks({ tokenProvider: async () => { throw reauth(); } });
    const res = await storageRoute.GET(req('/api/drive/storage', { token }), ctx({}));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('reauth_required');
  });
  it('maps Drive quota exceeded', async () => {
    const a = await seedUser(repo);
    const { token } = await issueSession(a.id, null);
    drive.quotaExceeded = true;
    const res = await storageRoute.GET(req('/api/drive/storage', { token }), ctx({}));
    expect(res.status).toBe(507);
    expect((await res.json()).error.code).toBe('drive_quota');
  });
});

describe('auth endpoints', () => {
  it('start rejects redirect URIs of unknown extensions', async () => {
    const res = await startRoute.GET(req('/api/auth/google/start?redirect_uri=https://evil.example/cb&state=aaaaaaaaaaaaaaaa&code_challenge=' + 'a'.repeat(43)), ctx({}));
    expect(res.status).toBe(400);
  });
  it('start redirects allowed extensions to Google with drive.file and offline access', async () => {
    const res = await startRoute.GET(req(`/api/auth/google/start?redirect_uri=${encodeURIComponent('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/auth')}&state=aaaaaaaaaaaaaaaa&code_challenge=${'a'.repeat(43)}`), ctx({}));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe('https://accounts.google.com');
    expect(loc.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive.file');
    expect(loc.searchParams.get('scope')).not.toMatch(/auth\/drive( |$)/);
    expect(loc.searchParams.get('access_type')).toBe('offline');
  });
  it('exchange requires the matching PKCE verifier and is single-use', async () => {
    const u = await seedUser(repo);
    const verifier = 'v'.repeat(50);
    const code = 'c'.repeat(43);
    const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/auth';
    await repo.createAuthCode({ codeHash: sha256Hex(code), userId: u.id, codeChallenge: sha256Base64Url(verifier), redirectUri: redirect, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const bad = await exchangeRoute.POST(req('/api/auth/exchange', { method: 'POST', body: { code, code_verifier: 'w'.repeat(50), redirect_uri: redirect } }), ctx({}));
    expect(bad.status).toBe(401);
    // code was consumed by the failed attempt: a stolen code + wrong verifier burns it
    const again = await exchangeRoute.POST(req('/api/auth/exchange', { method: 'POST', body: { code, code_verifier: verifier, redirect_uri: redirect } }), ctx({}));
    expect(again.status).toBe(401);
  });
  it('exchange issues a session for a valid code', async () => {
    const u = await seedUser(repo);
    const verifier = 'v'.repeat(50);
    const code = 'd'.repeat(43);
    const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/auth';
    await repo.createAuthCode({ codeHash: sha256Hex(code), userId: u.id, codeChallenge: sha256Base64Url(verifier), redirectUri: redirect, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const ok = await exchangeRoute.POST(req('/api/auth/exchange', { method: 'POST', body: { code, code_verifier: verifier, redirect_uri: redirect } }), ctx({}));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.user.email).toBe(u.email);
    expect(body.token).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/refresh/i);
  });
});

describe('public share endpoints', () => {
  async function shared(opts: { allowDownload?: boolean; days?: number | null } = {}) {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: opts.days ?? null, allowDownload: opts.allowDownload ?? true });
    return { u, a, link, token: link.url!.split('/s/')[1] };
  }
  it('streams content for a valid token with range support and sandbox headers', async () => {
    const { token } = await shared();
    const res = await shareContent.GET(req(`/api/public/shares/${token}/content`, { headers: { range: 'bytes=2-5' } }), ctx({ token }));
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('2345');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  });
  it('blocks downloads when the owner disabled them', async () => {
    const { token } = await shared({ allowDownload: false });
    const res = await shareContent.GET(req(`/api/public/shares/${token}/content?download=1`), ctx({ token }));
    expect(res.status).toBe(403);
  });
  it('returns 404 for invalid tokens and 410 for revoked/expired', async () => {
    expect((await shareMeta.GET(req('/api/public/shares/nope'), ctx({ token: 'nope' }))).status).toBe(404);
    const { link, token, u } = await shared();
    const { revokeShare } = await import('@/lib/services/shares');
    await revokeShare(u.id, link.id);
    const res = await shareContent.GET(req(`/api/public/shares/${token}/content`), ctx({ token }));
    expect(res.status).toBe(410);
  });
  it('never exposes Drive ids or owner email in public metadata', async () => {
    const { token, a } = await shared();
    const body = await (await shareMeta.GET(req(`/api/public/shares/${token}`), ctx({ token }))).text();
    expect(body).not.toContain(a.driveFileId);
    expect(body).not.toContain('@example.com');
  });
  it('rate limits public endpoints per IP', async () => {
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await shareMeta.GET(req('/api/public/shares/x'), ctx({ token: 'x' }))).status;
    expect(last).toBe(429);
  });
  it('cron endpoint requires the secret', async () => {
    silenceConsole();
    expect((await cronRoute.GET(req('/api/cron/expire-shares'), ctx({}))).status).toBe(401);
    expect((await cronRoute.GET(req('/api/cron/expire-shares', { headers: { authorization: 'Bearer cron-secret' } }), ctx({}))).status).toBe(200);
  });
});
