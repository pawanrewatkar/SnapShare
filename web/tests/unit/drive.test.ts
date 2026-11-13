import { describe, expect, it, vi } from 'vitest';
import { DriveApiError, DriveClient } from '@/lib/drive';
import { getUserAccessToken, setDriveTestHooks } from '@/lib/driveAccess';
import { encrypt } from '@/lib/crypto';
import { MemoryRepo } from '@/lib/repo/memory';
import { setRepo } from '@/lib/repo';

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('DriveClient (mocked HTTP)', () => {
  it('escapes folder names in search queries', async () => {
    const f = vi.fn(async () => jsonRes({ files: [] }));
    await new DriveClient('t', f as unknown as typeof fetch).findFolder("O'Brien's", 'root');
    const url = new URL(String((f.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('q')).toContain("name = 'O\\'Brien\\'s'");
  });
  it('treats 404 / trashed files as missing', async () => {
    const c = new DriveClient('t', (async () => jsonRes({ error: { message: 'File not found', errors: [{ reason: 'notFound' }] } }, 404)) as unknown as typeof fetch);
    expect(await c.getFileIfExists('x')).toBeNull();
    const c2 = new DriveClient('t', (async () => jsonRes({ id: 'x', trashed: true })) as unknown as typeof fetch);
    expect(await c2.getFileIfExists('x')).toBeNull();
  });
  it('parses quota errors', async () => {
    const c = new DriveClient('t', (async () => jsonRes({ error: { message: 'quota', errors: [{ reason: 'storageQuotaExceeded' }] } }, 403)) as unknown as typeof fetch);
    const e = await c.about().catch((x) => x);
    expect(e).toBeInstanceOf(DriveApiError);
    expect(e.isQuota).toBe(true);
  });
  it('creates anyone permissions as non-discoverable readers', async () => {
    const f = vi.fn(async () => jsonRes({ id: 'p', type: 'anyone', role: 'reader' }));
    await new DriveClient('t', f as unknown as typeof fetch).createPermission('file', { type: 'anyone' });
    const init = (f.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ type: 'anyone', role: 'reader', allowFileDiscovery: false });
  });
});

describe('server-side Google token refresh', () => {
  it('marks credentials revoked and asks for re-auth on invalid_grant', async () => {
    const repo = new MemoryRepo();
    setRepo(repo);
    setDriveTestHooks({ tokenProvider: null });
    await repo.saveRefreshToken('u1', encrypt('rt', process.env.ENCRYPTION_KEY!));
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ error: 'invalid_grant' }, 400)));
    await expect(getUserAccessToken('u1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect((await repo.getRefreshToken('u1'))!.revokedAt).not.toBeNull();
    await expect(getUserAccessToken('u1')).rejects.toMatchObject({ code: 'reauth_required' });
    vi.unstubAllGlobals();
  });
  it('refreshes and caches access tokens', async () => {
    const repo = new MemoryRepo();
    setRepo(repo);
    setDriveTestHooks({ tokenProvider: null });
    await repo.saveRefreshToken('u2', encrypt('rt', process.env.ENCRYPTION_KEY!));
    const f = vi.fn(async () => jsonRes({ access_token: 'ya29', expires_in: 3600, scope: '', token_type: 'Bearer' }));
    vi.stubGlobal('fetch', f);
    expect((await getUserAccessToken('u2')).token).toBe('ya29');
    expect((await getUserAccessToken('u2')).token).toBe('ya29');
    expect(f).toHaveBeenCalledTimes(1);
    const body = String(((f.mock.calls[0] as unknown[])[1] as RequestInit).body);
    expect(body).toContain('grant_type=refresh_token');
    vi.unstubAllGlobals();
  });
});
