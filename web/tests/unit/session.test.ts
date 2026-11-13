import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { issueSession, verifySessionToken } from '@/lib/auth';
import { setup, seedUser } from '../helpers';
import type { MemoryRepo } from '@/lib/repo/memory';

let repo: MemoryRepo;
beforeEach(() => {
  ({ repo } = setup());
});

describe('extension sessions', () => {
  it('issues and verifies a session bound to a server-side row', async () => {
    const u = await seedUser(repo);
    const s = await issueSession(u.id, 'ua');
    expect((await verifySessionToken(s.token)).userId).toBe(u.id);
  });
  it('rejects revoked sessions (sign-out)', async () => {
    const u = await seedUser(repo);
    const s = await issueSession(u.id, null);
    const ctx = await verifySessionToken(s.token);
    await repo.revokeSession(ctx.sessionId);
    await expect(verifySessionToken(s.token)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });
  it('rejects forged and expired tokens', async () => {
    const u = await seedUser(repo);
    const forged = await new SignJWT({ sid: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer('snapshare').setAudience('snapshare-extension').setExpirationTime('1h').sign(new TextEncoder().encode('y'.repeat(48)));
    await expect(verifySessionToken(forged)).rejects.toMatchObject({ status: 401 });
    const expired = await new SignJWT({ sid: 'x' }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id).setIssuer('snapshare').setAudience('snapshare-extension').setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    await expect(verifySessionToken(expired)).rejects.toMatchObject({ status: 401 });
    await expect(verifySessionToken('garbage')).rejects.toMatchObject({ status: 401 });
  });
  it('one-time auth codes cannot be replayed or used after expiry', async () => {
    const u = await seedUser(repo);
    await repo.createAuthCode({ codeHash: 'h', userId: u.id, codeChallenge: 'c', redirectUri: 'r', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await repo.consumeAuthCode('h', new Date())).not.toBeNull();
    expect(await repo.consumeAuthCode('h', new Date())).toBeNull();
    await repo.createAuthCode({ codeHash: 'old', userId: u.id, codeChallenge: 'c', redirectUri: 'r', expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(await repo.consumeAuthCode('old', new Date())).toBeNull();
  });
});
