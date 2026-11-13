/**
 * Minimal Google Drive v3 REST client (no SDK) with typed errors.
 * Uses only the drive.file scope: every operation targets files/folders SnapShare created.
 */
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveApiError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isQuota() {
    return this.reason === 'storageQuotaExceeded';
  }
  get isAuth() {
    return this.status === 401;
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  trashed?: boolean;
  parents?: string[];
  appProperties?: Record<string, string>;
  thumbnailLink?: string;
  webViewLink?: string;
  createdTime?: string;
}

export interface DrivePermissionRaw {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: string;
  emailAddress?: string;
  displayName?: string;
}

export class DriveClient {
  constructor(
    private accessToken: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async req(path: string, init: RequestInit & { query?: Record<string, string> } = {}): Promise<Response> {
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const res = await this.fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.accessToken}` } });
    if (!res.ok && res.status !== 206) {
      let reason = '';
      let message = `Drive error ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
        reason = body.error?.errors?.[0]?.reason ?? '';
        message = body.error?.message ?? message;
      } catch {
        /* ignore */
      }
      throw new DriveApiError(res.status, reason, message);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit & { query?: Record<string, string> }): Promise<T> {
    return (await (await this.req(path, init)).json()) as T;
  }

  getFile(id: string, fields = 'id,name,mimeType,size,trashed,parents,appProperties,webViewLink'): Promise<DriveFile> {
    return this.json<DriveFile>(`/files/${encodeURIComponent(id)}`, { query: { fields, supportsAllDrives: 'true' } });
  }

  /** Returns null when the file was deleted or trashed. */
  async getFileIfExists(id: string, fields?: string): Promise<DriveFile | null> {
    try {
      const f = await this.getFile(id, fields);
      return f.trashed ? null : f;
    } catch (e) {
      if (e instanceof DriveApiError && e.isNotFound) return null;
      throw e;
    }
  }

  async findFolder(name: string, parentId: string): Promise<DriveFile | null> {
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `name = '${esc}' and mimeType = '${FOLDER_MIME}' and '${parentId}' in parents and trashed = false`;
    const res = await this.json<{ files: DriveFile[] }>('/files', { query: { q, fields: 'files(id,name,createdTime)', orderBy: 'createdTime', pageSize: '10', spaces: 'drive' } });
    return res.files[0] ?? null;
  }

  createFolder(name: string, parentId: string): Promise<DriveFile> {
    return this.json<DriveFile>('/files', {
      method: 'POST',
      query: { fields: 'id,name' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties: { snapshare: '1' } }),
    });
  }

  rename(id: string, name: string): Promise<DriveFile> {
    return this.json<DriveFile>(`/files/${encodeURIComponent(id)}`, { method: 'PATCH', query: { fields: 'id,name' }, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  }

  /** Permanently deletes. Treats already-deleted files as success. */
  async delete(id: string): Promise<void> {
    try {
      await this.req(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
      if (e instanceof DriveApiError && e.isNotFound) return;
      throw e;
    }
  }

  async listPermissions(id: string): Promise<DrivePermissionRaw[]> {
    const r = await this.json<{ permissions: DrivePermissionRaw[] }>(`/files/${encodeURIComponent(id)}/permissions`, { query: { fields: 'permissions(id,type,role,emailAddress,displayName)' } });
    return r.permissions ?? [];
  }

  createPermission(id: string, perm: { type: 'anyone' } | { type: 'user'; emailAddress: string }, notify = false): Promise<DrivePermissionRaw> {
    return this.json<DrivePermissionRaw>(`/files/${encodeURIComponent(id)}/permissions`, {
      method: 'POST',
      query: { fields: 'id,type,role,emailAddress,displayName', sendNotificationEmail: String(perm.type === 'user' && notify) },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...perm, role: 'reader', ...(perm.type === 'anyone' ? { allowFileDiscovery: false } : {}) }),
    });
  }

  async deletePermission(id: string, permissionId: string): Promise<void> {
    try {
      await this.req(`/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`, { method: 'DELETE' });
    } catch (e) {
      if (e instanceof DriveApiError && e.isNotFound) return;
      throw e;
    }
  }

  async about(): Promise<{ limit: number | null; usage: number; usageInDrive: number }> {
    const r = await this.json<{ storageQuota: { limit?: string; usage?: string; usageInDrive?: string } }>('/about', { query: { fields: 'storageQuota' } });
    return { limit: r.storageQuota.limit ? Number(r.storageQuota.limit) : null, usage: Number(r.storageQuota.usage ?? 0), usageInDrive: Number(r.storageQuota.usageInDrive ?? 0) };
  }

  /** Streams file bytes; forwards an optional HTTP Range header. */
  download(id: string, range?: string | null): Promise<Response> {
    return this.req(`/files/${encodeURIComponent(id)}`, { query: { alt: 'media' }, headers: range ? { Range: range } : {} });
  }

  async thumbnail(id: string): Promise<Response | null> {
    const f = await this.getFile(id, 'id,thumbnailLink');
    if (!f.thumbnailLink) return null;
    // Request a larger rendition than Drive's default 220px.
    const link = f.thumbnailLink.replace(/=s\d+$/, '=s480');
    // thumbnailLink is short-lived and usually works unauthenticated; retry with the bearer token if not.
    const res = await this.fetchFn(link);
    if (res.ok) return res;
    const authed = await this.fetchFn(link, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    return authed.ok ? authed : null;
  }
}
