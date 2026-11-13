import { vi } from 'vitest';
import type { DriveClient, DriveFile, DrivePermissionRaw } from '@/lib/drive';
import { DriveApiError } from '@/lib/drive';
import { setDriveTestHooks } from '@/lib/driveAccess';
import { MemoryRepo } from '@/lib/repo/memory';
import { setRepo } from '@/lib/repo';

/** In-memory fake of the subset of Drive used by SnapShare. Mocked: proves our logic, not Google's API. */
export class FakeDrive {
  files = new Map<string, DriveFile & { bytes?: Uint8Array }>();
  perms = new Map<string, DrivePermissionRaw[]>();
  quotaExceeded = false;
  seq = 0;

  add(f: Partial<DriveFile> & { id: string }) {
    this.files.set(f.id, { name: 'f', mimeType: 'image/png', size: '10', appProperties: { snapshare: '1' }, parents: ['screens'], ...f });
    this.perms.set(f.id, [{ id: 'owner', type: 'user', role: 'owner', emailAddress: 'me@example.com' }]);
  }

  client(): DriveClient {
    const notFound = () => new DriveApiError(404, 'notFound', 'File not found');
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async getFile(id: string) {
        const f = self.files.get(id);
        if (!f) throw notFound();
        return { ...f, webViewLink: `https://drive.google.com/file/d/${id}/view` };
      },
      async getFileIfExists(id: string) {
        const f = self.files.get(id);
        return f && !f.trashed ? f : null;
      },
      async findFolder(name: string, parent: string) {
        return [...self.files.values()].find((f) => f.name === name && f.parents?.includes(parent) && f.mimeType.includes('folder')) ?? null;
      },
      async createFolder(name: string, parent: string) {
        const id = `folder-${++self.seq}`;
        self.files.set(id, { id, name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] });
        return { id, name, mimeType: 'application/vnd.google-apps.folder' };
      },
      async rename(id: string, name: string) {
        const f = self.files.get(id);
        if (!f) throw notFound();
        f.name = name;
        return f;
      },
      async delete(id: string) {
        self.files.delete(id);
      },
      async listPermissions(id: string) {
        if (!self.files.has(id)) throw notFound();
        return [...(self.perms.get(id) ?? [])];
      },
      async createPermission(id: string, p: { type: 'anyone' } | { type: 'user'; emailAddress: string }) {
        if (!self.files.has(id)) throw notFound();
        const perm: DrivePermissionRaw = { id: `perm-${++self.seq}`, role: 'reader', ...p } as DrivePermissionRaw;
        self.perms.set(id, [...(self.perms.get(id) ?? []), perm]);
        return perm;
      },
      async deletePermission(id: string, pid: string) {
        self.perms.set(id, (self.perms.get(id) ?? []).filter((p) => p.id !== pid));
      },
      async about() {
        if (self.quotaExceeded) throw new DriveApiError(403, 'storageQuotaExceeded', 'quota');
        return { limit: 100, usage: 50, usageInDrive: 40 };
      },
      async download(id: string, range?: string | null) {
        const f = self.files.get(id);
        if (!f) throw notFound();
        const bytes = new Uint8Array(f.bytes ?? new TextEncoder().encode('0123456789'));
        if (range) {
          const [s, e] = range.replace('bytes=', '').split('-').map((x) => (x ? Number(x) : undefined));
          const start = s ?? 0;
          const end = e ?? bytes.length - 1;
          return new Response(new Blob([bytes.slice(start, end + 1)]), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) } });
        }
        return new Response(new Blob([bytes]), { status: 200, headers: { 'Content-Length': String(bytes.length) } });
      },
      async thumbnail() {
        return null;
      },
    } as unknown as DriveClient;
  }
}

export function setup() {
  const repo = new MemoryRepo();
  const drive = new FakeDrive();
  setRepo(repo);
  setDriveTestHooks({ factory: () => drive.client(), tokenProvider: async () => ({ token: 'access', expiresAt: Date.now() + 3600_000 }) });
  return { repo, drive };
}

export async function seedUser(repo: MemoryRepo, email = 'me@example.com') {
  return repo.upsertUserFromGoogle({ sub: `sub-${email}`, email, name: email.split('@')[0], picture: null, scopes: [] });
}

export async function seedAsset(repo: MemoryRepo, drive: FakeDrive, userId: string, driveFileId = `file-${Math.random().toString(36).slice(2)}`) {
  drive.add({ id: driveFileId });
  return repo.insertAsset({ userId, driveFileId, filename: 'shot.png', mediaType: 'screenshot', mimeType: 'image/png', size: 10, width: 10, height: 10, durationMs: null, parentAssetId: null });
}

export const silenceConsole = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
