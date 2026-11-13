/**
 * Google Drive v3 REST client used directly by the extension (no backend).
 * Scope drive.file: only files/folders SnapShare created are visible or modifiable.
 */
import { authFetch } from '@/features/authentication/auth';
import { DriveError } from './upload';

const API = 'https://www.googleapis.com/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const FILE_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,trashed,parents,appProperties,webViewLink,thumbnailLink,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis)';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  trashed?: boolean;
  parents?: string[];
  appProperties?: Record<string, string>;
  webViewLink?: string;
  thumbnailLink?: string;
  imageMediaMetadata?: { width?: number; height?: number };
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
}

export interface DrivePermission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: string;
  emailAddress?: string;
  displayName?: string;
  domain?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (u, i) => authFetch(u, i);
/** Test hook. */
export function setDriveFetcher(f: Fetcher | null) {
  fetcher = f ?? ((u, i) => authFetch(u, i));
}

async function toDriveError(res: Response): Promise<DriveError> {
  let reason = '';
  let message = `Google Drive error (${res.status})`;
  try {
    const b = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    reason = b.error?.errors?.[0]?.reason ?? '';
    if (b.error?.message) message = b.error.message;
  } catch {
    /* ignore */
  }
  if (reason === 'storageQuotaExceeded') return new DriveError('quota', 'Your Google Drive storage quota is exceeded.');
  if (res.status === 401) return new DriveError('auth', 'Google authorization expired.');
  if (res.status === 404) return new DriveError('not_found', 'File not found in Google Drive.');
  return new DriveError('server', message);
}

async function call(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<Response> {
  const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetcher(url.toString(), init);
  } catch (e) {
    if ((e as Error)?.name === 'AuthError') throw e;
    throw new DriveError('network', 'Network error talking to Google Drive.');
  }
  if (!res.ok) throw await toDriveError(res);
  return res;
}
const json = async <T>(path: string, init?: RequestInit & { query?: Record<string, string> }) => (await (await call(path, init)).json()) as T;
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export const drive = {
  getFile: (id: string, fields = FILE_FIELDS) => json<DriveFile>(`/files/${encodeURIComponent(id)}`, { query: { fields } }),

  async getFileIfExists(id: string, fields = 'id,trashed,parents'): Promise<DriveFile | null> {
    try {
      const f = await drive.getFile(id, fields);
      return f.trashed ? null : f;
    } catch (e) {
      if (e instanceof DriveError && e.code === 'not_found') return null;
      throw e;
    }
  },

  /** Oldest non-trashed SnapShare folder with this name under parent (oldest wins → stable, no duplicates). */
  async findFolders(name: string, parentId: string): Promise<DriveFile[]> {
    const query = `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and '${q(parentId)}' in parents and trashed = false`;
    const r = await json<{ files: DriveFile[] }>('/files', { query: { q: query, fields: 'files(id,name,createdTime)', orderBy: 'createdTime', pageSize: '20', spaces: 'drive' } });
    return r.files ?? [];
  },

  createFolder: (name: string, parentId: string) =>
    json<DriveFile>('/files', {
      method: 'POST',
      query: { fields: 'id,name' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties: { snapshare: '1' } }),
    }),

  /** Lists every non-trashed file in a folder (paged). */
  async listFolder(folderId: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const r = await json<{ files: DriveFile[]; nextPageToken?: string }>('/files', {
        query: { q: `'${q(folderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`, fields: `nextPageToken,files(${FILE_FIELDS})`, orderBy: 'createdTime desc', pageSize: '200', spaces: 'drive', ...(pageToken ? { pageToken } : {}) },
      });
      out.push(...(r.files ?? []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  },

  rename: (id: string, name: string) =>
    json<DriveFile>(`/files/${encodeURIComponent(id)}`, { method: 'PATCH', query: { fields: 'id,name' }, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),

  /** Permanent delete; already-deleted counts as success. */
  async delete(id: string) {
    try {
      await call(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof DriveError && e.code === 'not_found')) throw e;
    }
  },

  async listPermissions(id: string): Promise<DrivePermission[]> {
    const r = await json<{ permissions: DrivePermission[] }>(`/files/${encodeURIComponent(id)}/permissions`, { query: { fields: 'permissions(id,type,role,emailAddress,displayName,domain)' } });
    return r.permissions ?? [];
  },

  /** Grants reader access to ONE file. Never called with folder ids by the sharing UI. */
  createPermission: (id: string, perm: { type: 'anyone' } | { type: 'user'; emailAddress: string }, notify = false, message?: string) =>
    json<DrivePermission>(`/files/${encodeURIComponent(id)}/permissions`, {
      method: 'POST',
      query: { fields: 'id,type,role,emailAddress,displayName', sendNotificationEmail: String(perm.type === 'user' && notify), ...(perm.type === 'user' && notify && message ? { emailMessage: message } : {}) },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...perm, role: 'reader', ...(perm.type === 'anyone' ? { allowFileDiscovery: false } : {}) }),
    }),

  async deletePermission(id: string, permissionId: string) {
    try {
      await call(`/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e instanceof DriveError && e.code === 'not_found')) throw e;
    }
  },

  async about(): Promise<{ limit: number | null; usage: number; usageInDrive: number }> {
    const r = await json<{ storageQuota: { limit?: string; usage?: string; usageInDrive?: string } }>('/about', { query: { fields: 'storageQuota' } });
    return { limit: r.storageQuota.limit ? Number(r.storageQuota.limit) : null, usage: Number(r.storageQuota.usage ?? 0), usageInDrive: Number(r.storageQuota.usageInDrive ?? 0) };
  },

  mediaUrl: (id: string) => `${API}/files/${encodeURIComponent(id)}?alt=media`,

  /** Downloads file bytes as a Blob (previews, copy-to-clipboard). */
  async downloadBlob(id: string): Promise<Blob> {
    return (await call(`/files/${encodeURIComponent(id)}`, { query: { alt: 'media' } })).blob();
  },

  async thumbnailBlob(file: DriveFile): Promise<Blob | null> {
    if (!file.thumbnailLink) return null;
    const link = file.thumbnailLink.replace(/=s\d+$/, '=s480');
    try {
      const res = await fetch(link);
      if (res.ok) return res.blob();
      const authed = await fetcher(link);
      return authed.ok ? authed.blob() : null;
    } catch {
      return null;
    }
  },
};
