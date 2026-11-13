// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDrive } from './fakeDrive';
import { setDriveFetcher, drive } from '@/features/drive/driveApi';
import { ensureFolders, folderForMedia } from '@/features/drive/driveService';
import { analyzeSharing, fileUrl, isValidEmail } from '@/features/sharing/permissions';
import { loadSharing } from '@/features/sharing/ShareDialog';
import { setSession } from '@/services/api';

let fd: FakeDrive;
const as = async (account: 'A' | 'B') => {
  fd.currentAccount = account;
  await setSession({ user: { id: `sub-${account}`, email: fd.emails[account], name: account, avatarUrl: null } });
};
const names = () => [...fd.files.values()].filter((f) => f.mimeType.includes('folder')).map((f) => `${f.owner}:${f.name}`).sort();
const upload = (folder: string, name: string, mediaType = 'screenshot') => {
  const id = `file-${name}`;
  fd.files.set(id, { id, name, mimeType: mediaType === 'video' ? 'video/webm' : 'image/png', parents: [folder], appProperties: { snapshare: '1', mediaType }, owner: fd.currentAccount });
  fd.perms.set(id, [{ id: `owner-${fd.currentAccount}`, type: 'user', role: 'owner', emailAddress: fd.emails[fd.currentAccount] }]);
  return id;
};

beforeEach(async () => {
  fd = new FakeDrive();
  setDriveFetcher(fd.fetch);
  await chrome.storage.local.remove('driveFolders:sub-A');
  await chrome.storage.local.remove('driveFolders:sub-B');
  await as('A');
});

describe('Drive folder structure (mocked Drive)', () => {
  it('creates My Drive/SnapShare/{Screenshots,Videos} only', async () => {
    const f = await ensureFolders();
    expect(names()).toEqual(['A:Screenshots', 'A:SnapShare', 'A:Videos']);
    expect(fd.files.get(f.root)!.parents).toEqual(['root']);
    expect(fd.files.get(f.screenshots)!.parents).toEqual([f.root]);
    expect(fd.files.get(f.videos)!.parents).toEqual([f.root]);
  });
  it('edited screenshots go to Screenshots, recordings to Videos', () => {
    expect(folderForMedia('screenshot')).toBe('screenshots');
    expect(folderForMedia('edited')).toBe('screenshots');
    expect(folderForMedia('video')).toBe('videos');
  });
  it('never creates duplicates (repeat calls, concurrent calls, lost local cache)', async () => {
    await Promise.all([ensureFolders(), ensureFolders(), ensureFolders()]);
    await ensureFolders();
    await chrome.storage.local.remove('driveFolders:sub-A');
    await ensureFolders();
    expect(names()).toEqual(['A:Screenshots', 'A:SnapShare', 'A:Videos']);
  });
  it('recreates a folder the user deleted', async () => {
    const f = await ensureFolders();
    fd.files.delete(f.videos);
    const f2 = await ensureFolders();
    expect(f2.videos).not.toBe(f.videos);
    expect(names()).toEqual(['A:Screenshots', 'A:SnapShare', 'A:Videos']);
  });
  it('stores folder ids per account (accounts never share folders)', async () => {
    const a = await ensureFolders();
    await as('B');
    const b = await ensureFolders();
    expect(b.root).not.toBe(a.root);
    expect(names()).toEqual(['A:Screenshots', 'A:SnapShare', 'A:Videos', 'B:Screenshots', 'B:SnapShare', 'B:Videos']);
    expect(await chrome.storage.local.get('driveFolders:sub-A')).toBeTruthy();
  });
});

describe('individual-file sharing & account isolation (mocked Drive — real test BLOCKED, see docs)', () => {
  it('shares only the selected file with B; B cannot see other files or folders; revoke removes access', async () => {
    const f = await ensureFolders();
    const shot1 = upload(f.screenshots, 'one.png');
    const shot2 = upload(f.screenshots, 'two.png');
    const vid = upload(f.videos, 'rec.webm', 'video');
    const p = await drive.createPermission(shot1, { type: 'user', emailAddress: 'b@gmail.com' });
    expect(fd.perms.get(f.screenshots)!.filter((x) => x.role !== 'owner')).toEqual([]); // folder untouched
    expect(fd.perms.get(f.root)!.filter((x) => x.role !== 'owner')).toEqual([]);
    await as('B');
    expect(await drive.getFileIfExists(shot1, 'id')).not.toBeNull();
    for (const other of [shot2, vid, f.root, f.screenshots, f.videos]) expect(await drive.getFileIfExists(other, 'id')).toBeNull();
    await expect(drive.listPermissions(shot1)).rejects.toThrow(); // recipient can't manage sharing
    await as('A');
    await drive.deletePermission(shot1, p.id);
    await as('B');
    expect(await drive.getFileIfExists(shot1, 'id')).toBeNull();
  });
  it('anyone-with-link applies to one file only, as a non-discoverable reader', async () => {
    const f = await ensureFolders();
    const a = upload(f.screenshots, 'a.png');
    const b = upload(f.screenshots, 'b.png');
    const calls: RequestInit[] = [];
    setDriveFetcher(async (u, i) => (i?.method === 'POST' && u.includes('/permissions') && calls.push(i!), fd.fetch(u, i)));
    await drive.createPermission(a, { type: 'anyone' });
    expect(JSON.parse(String(calls[0].body))).toEqual({ type: 'anyone', role: 'reader', allowFileDiscovery: false });
    fd.currentAccount = 'C';
    expect(fd.canSee(a, 'C')).toBe(true);
    expect(fd.canSee(b, 'C')).toBe(false);
    expect(fd.canSee(f.screenshots, 'C')).toBe(false);
  });
  it('reports inherited exposure from a shared parent folder and never claims "private"', async () => {
    const f = await ensureFolders();
    const a = upload(f.screenshots, 'a.png');
    let s = await loadSharing(a);
    expect(s.state.isPrivate).toBe(true);
    // the owner shared the Screenshots folder in the Drive UI
    fd.perms.get(f.screenshots)!.push({ id: 'anyoneWithLink', type: 'anyone', role: 'reader' });
    s = await loadSharing(a);
    expect(s.state.isPrivate).toBe(false);
    expect(s.state.anyoneWithLink).toBe(true);
    expect(s.state.inherited[0]).toMatchObject({ folderName: 'SnapShare/Screenshots', type: 'anyone' });
    expect(s.state.summary).toMatch(/shared SnapShare folder/);
  });
});

describe('sharing state analysis', () => {
  const owner = { id: 'o', type: 'user' as const, role: 'owner', emailAddress: 'a@gmail.com' };
  it('private when only the owner has access', () => {
    expect(analyzeSharing([owner], []).summary).toMatch(/^Private/);
  });
  it('separates direct grants from grants inherited via a folder', () => {
    const folderGrant = { id: 'u-team', type: 'user' as const, role: 'reader', emailAddress: 'team@gmail.com' };
    const s = analyzeSharing([owner, folderGrant, { id: 'u-b', type: 'user', role: 'reader', emailAddress: 'b@gmail.com' }], [{ folderId: 'F', folderName: 'SnapShare', permissions: [owner, folderGrant] }]);
    expect(s.direct.map((p) => p.emailAddress)).toEqual(['b@gmail.com']);
    expect(s.inherited.map((p) => p.emailAddress)).toEqual(['team@gmail.com']);
    expect(s.isPrivate).toBe(false);
  });
  it('builds file (never folder) URLs and validates emails', () => {
    expect(fileUrl('abc')).toBe('https://drive.google.com/file/d/abc/view?usp=sharing');
    expect(fileUrl('abc', 'https://drive.google.com/drive/folders/xyz')).toBe('https://drive.google.com/file/d/abc/view?usp=sharing');
    expect(isValidEmail('b@gmail.com')).toBe(true);
    expect(isValidEmail('nope')).toBe(false);
  });
});
