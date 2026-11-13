import { beforeEach, describe, expect, it } from 'vitest';
import { addPermission, deleteAssetFully, ensureFolders, getOwnedAsset, reconcileAssets, registerAsset, removePermission, renameAsset } from '@/lib/services/assets';
import { createShare } from '@/lib/services/shares';
import { FakeDrive, seedAsset, seedUser, setup } from '../helpers';
import type { MemoryRepo } from '@/lib/repo/memory';

let repo: MemoryRepo;
let drive: FakeDrive;
beforeEach(() => {
  ({ repo, drive } = setup());
});

const reg = (driveFileId: string, extra = {}) => ({ driveFileId, filename: 'a.png', mediaType: 'screenshot', mimeType: 'image/png', size: 10, ...extra });

describe('Drive folder structure', () => {
  it('creates SnapShare/{Screenshots,Edited Images,Videos} once and reuses existing folders', async () => {
    const u = await seedUser(repo);
    const f1 = await ensureFolders(u.id);
    const names = [...drive.files.values()].map((f) => f.name).sort();
    expect(names).toEqual(['Edited Images', 'Screenshots', 'SnapShare', 'Videos']);
    const f2 = await ensureFolders(u.id);
    expect(f2).toEqual(f1);
    expect(drive.files.size).toBe(4);
  });
  it('finds existing Drive folders before creating (e.g. after reinstall / lost metadata)', async () => {
    const u = await seedUser(repo);
    await ensureFolders(u.id);
    repo.folders.clear();
    await ensureFolders(u.id);
    expect(drive.files.size).toBe(4);
  });
  it('recreates a folder the user deleted in Drive', async () => {
    const u = await seedUser(repo);
    const f = await ensureFolders(u.id);
    drive.files.delete(f.videos);
    const f2 = await ensureFolders(u.id);
    expect(f2.videos).not.toBe(f.videos);
    expect(drive.files.get(f2.videos)?.parents).toEqual([f.root]);
  });
});

describe('asset registration', () => {
  it('registers a file uploaded by SnapShare into the user folder', async () => {
    const u = await seedUser(repo);
    const folders = await ensureFolders(u.id);
    drive.add({ id: 'F1', parents: [folders.screenshots] });
    const a = await registerAsset(u.id, reg('F1') as never);
    expect(a.driveFileId).toBe('F1');
    expect(repo.activity.at(-1)?.action).toBe('upload');
    // idempotent
    expect((await registerAsset(u.id, reg('F1') as never)).id).toBe(a.id);
  });
  it('rejects files not created by SnapShare, wrong size/type, wrong folder, or missing', async () => {
    const u = await seedUser(repo);
    const folders = await ensureFolders(u.id);
    drive.add({ id: 'NOTOURS', parents: [folders.screenshots], appProperties: {} });
    await expect(registerAsset(u.id, reg('NOTOURS') as never)).rejects.toMatchObject({ status: 400 });
    drive.add({ id: 'SIZE', parents: [folders.screenshots], size: '999' });
    await expect(registerAsset(u.id, reg('SIZE') as never)).rejects.toMatchObject({ status: 400 });
    drive.add({ id: 'FOLDER', parents: ['elsewhere'] });
    await expect(registerAsset(u.id, reg('FOLDER') as never)).rejects.toMatchObject({ status: 400 });
    await expect(registerAsset(u.id, reg('GONE') as never)).rejects.toMatchObject({ status: 404, code: 'drive_missing' });
    await expect(registerAsset(u.id, reg('X', { mimeType: 'text/html' }) as never)).rejects.toMatchObject({ status: 400 });
  });
});

describe('gallery ownership and file management', () => {
  it('hides other users assets (404, not 403)', async () => {
    const a = await seedUser(repo, 'a@example.com');
    const b = await seedUser(repo, 'b@example.com');
    const asset = await seedAsset(repo, drive, a.id);
    await expect(getOwnedAsset(b.id, asset.id)).rejects.toMatchObject({ status: 404 });
    await expect(renameAsset(b.id, asset.id, 'x')).rejects.toMatchObject({ status: 404 });
    await expect(deleteAssetFully(b.id, asset.id)).rejects.toMatchObject({ status: 404 });
    expect(drive.files.has(asset.driveFileId)).toBe(true);
    expect(await repo.listAssets(b.id, {})).toEqual([]);
  });
  it('renames in Drive and metadata, keeping the extension', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    const r = await renameAsset(u.id, a.id, 'Bug report');
    expect(r.filename).toBe('Bug report.png');
    expect(drive.files.get(a.driveFileId)?.name).toBe('Bug report.png');
  });
  it('delete removes the actual Drive file, metadata and share links', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    await createShare(u.id, a.id, { accessType: 'restricted', expiresInDays: null, allowDownload: true });
    await deleteAssetFully(u.id, a.id);
    expect(drive.files.has(a.driveFileId)).toBe(false);
    expect(await repo.getAsset(a.id)).toBeNull();
    expect(repo.shares.size).toBe(0);
  });
  it('delete succeeds when the file was already removed from Drive', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    drive.files.delete(a.driveFileId);
    await deleteAssetFully(u.id, a.id);
    expect(await repo.getAsset(a.id)).toBeNull();
  });
  it('reconcile marks files deleted/trashed in Drive as missing and restores returning ones', async () => {
    const u = await seedUser(repo);
    const a1 = await seedAsset(repo, drive, u.id);
    const a2 = await seedAsset(repo, drive, u.id);
    drive.files.delete(a1.driveFileId);
    drive.files.get(a2.driveFileId)!.trashed = true;
    expect(await reconcileAssets(u.id)).toEqual({ checked: 2, missing: 2, restored: 0 });
    expect((await repo.getAsset(a1.id))!.status).toBe('missing');
    drive.files.get(a2.driveFileId)!.trashed = false;
    expect((await reconcileAssets(u.id)).restored).toBe(1);
  });
  it('Drive permissions: make public, share with a user, remove public deactivates public links', async () => {
    const u = await seedUser(repo);
    const a = await seedAsset(repo, drive, u.id);
    let v = await addPermission(u.id, a.id, { type: 'anyone' });
    const anyone = v.permissions.find((p) => p.type === 'anyone')!;
    expect(anyone).toBeTruthy();
    expect(v.webViewLink).toContain(a.driveFileId);
    v = await addPermission(u.id, a.id, { type: 'user', email: 'friend@example.com' });
    expect(v.permissions.some((p) => p.emailAddress === 'friend@example.com')).toBe(true);
    const link = await createShare(u.id, a.id, { accessType: 'public', expiresInDays: null, allowDownload: true });
    v = await removePermission(u.id, a.id, anyone.id);
    expect(v.permissions.some((p) => p.type === 'anyone')).toBe(false);
    expect((await repo.getShare(link.id))!.isActive).toBe(false);
    await expect(removePermission(u.id, a.id, 'owner')).rejects.toMatchObject({ status: 400 });
  });
});
