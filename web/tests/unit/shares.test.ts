import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@/lib/crypto';
import { createShare, expireShares, listSharesForOwner, resolveShare, revokeShare, toPublicView } from '@/lib/services/shares';
import { FakeDrive, seedAsset, seedUser, setup } from '../helpers';
import type { MemoryRepo } from '@/lib/repo/memory';

let repo: MemoryRepo;
let drive: FakeDrive;
beforeEach(() => {
  ({ repo, drive } = setup());
});

const tokenOf = (url: string) => url.split('/s/')[1];

describe('share links', () => {
  it('stores only the token hash and an encrypted copy, never the raw token', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: 7, allowDownload: true });
    const token = tokenOf(link.url!);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = [...repo.shares.values()][0];
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(link.url).toBe(`https://snapshare.test/s/${token}`);
  });
  it('restricted links keep the Drive file private', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: null, allowDownload: false });
    expect(drive.perms.get(a.driveFileId)!.some((p) => p.type === 'anyone')).toBe(false);
    expect((await repo.getAsset(a.id))!.isDrivePublic).toBe(false);
  });
  it('public links grant Drive anyone-with-link only on explicit request, and revoke removes it', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'public', expiresInDays: null, allowDownload: true });
    expect(drive.perms.get(a.driveFileId)!.some((p) => p.type === 'anyone')).toBe(true);
    await revokeShare(u.id, link.id);
    expect(drive.perms.get(a.driveFileId)!.some((p) => p.type === 'anyone')).toBe(false);
    expect((await repo.getAsset(a.id))!.isDrivePublic).toBe(false);
  });
  it('keeps Drive public access while another public link is still active', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const l1 = await createShare(u.id, a.id, { accessType: 'public', expiresInDays: null, allowDownload: true });
    await createShare(u.id, a.id, { accessType: 'public', expiresInDays: null, allowDownload: true });
    await revokeShare(u.id, l1.id);
    expect(drive.perms.get(a.driveFileId)!.some((p) => p.type === 'anyone')).toBe(true);
  });
  it('resolves valid tokens with public-safe metadata only', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: 1, allowDownload: true });
    const view = toPublicView(await resolveShare(tokenOf(link.url!)));
    expect(view.status).toBe('ok');
    expect(view.filename).toBe('shot.png');
    expect(JSON.stringify(view)).not.toContain(a.driveFileId);
    expect(JSON.stringify(view)).not.toContain('me@example.com');
  });
  it('rejects invalid / unknown tokens', async () => {
    expect((await resolveShare('not-a-token')).status).toBe('not_found');
    expect((await resolveShare('A'.repeat(43))).status).toBe('not_found');
    expect((await resolveShare("' OR 1=1 --")).status).toBe('not_found');
  });
  it('reports expired links', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: 1, allowDownload: true });
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect((await resolveShare(tokenOf(link.url!), later)).status).toBe('expired');
  });
  it('reports revoked links', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: null, allowDownload: true });
    await revokeShare(u.id, link.id);
    expect((await resolveShare(tokenOf(link.url!))).status).toBe('revoked');
    const listed = await listSharesForOwner(u.id, a.id);
    expect(listed[0].isActive).toBe(false);
    expect(listed[0].url).toBeUndefined();
  });
  it('reports files deleted from Drive as missing', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: null, allowDownload: true });
    await repo.updateAsset(a.id, { status: 'missing' });
    expect((await resolveShare(tokenOf(link.url!))).status).toBe('missing');
  });
  it('enforces ownership: other users cannot create, list or revoke links', async () => {
    const owner = await seedUser(repo, 'owner@example.com');
    const attacker = await seedUser(repo, 'attacker@example.com');
    const a = await seedAsset(repo, drive, owner.id);
    await expect(createShare(attacker.id, a.id, { accessType: 'public', expiresInDays: null, allowDownload: true })).rejects.toMatchObject({ status: 404 });
    await expect(listSharesForOwner(attacker.id, a.id)).rejects.toMatchObject({ status: 404 });
    const link = await createShare(owner.id, a.id, { accessType: 'restricted', expiresInDays: null, allowDownload: true });
    await expect(revokeShare(attacker.id, link.id)).rejects.toMatchObject({ status: 404 });
    expect(drive.perms.get(a.driveFileId)!.some((p) => p.type === 'anyone')).toBe(false);
  });
  it('expiry job deactivates expired public links and withdraws Drive access', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const link = await createShare(u.id, a.id, { accessType: 'public', expiresInDays: 1, allowDownload: true });
    const r = await expireShares(new Date(Date.now() + 2 * 86_400_000));
    expect(r.expired).toBe(1);
    expect(drive.perms.get(a.driveFileId)!.some((p) => p.type === 'anyone')).toBe(false);
    expect((await resolveShare(tokenOf(link.url!), new Date(Date.now() + 3 * 86_400_000))).status).toBe('expired');
  });
});
