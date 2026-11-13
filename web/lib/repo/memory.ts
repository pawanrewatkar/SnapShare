import { randomUUID } from 'node:crypto';
import type { FolderType } from '@snapshare/shared';
import type { AssetRow, AuthCodeRow, GoogleIdentityInput, NewAsset, NewShare, Profile, Repo, SessionRow, ShareRow } from './types';

/**
 * In-memory Repo with the same ownership/uniqueness semantics as the SQL schema.
 * Used by unit and mocked-integration tests (and for local UI work without Supabase).
 */
export class MemoryRepo implements Repo {
  profiles = new Map<string, Profile>();
  googleSubs = new Map<string, string>();
  creds = new Map<string, { ciphertext: string; revokedAt: string | null }>();
  codes = new Map<string, AuthCodeRow & { usedAt: string | null }>();
  sessions = new Map<string, SessionRow>();
  folders = new Map<string, Partial<Record<FolderType, string>>>();
  assets = new Map<string, AssetRow>();
  shares = new Map<string, ShareRow>();
  activity: { userId: string; action: string; assetId: string | null }[] = [];
  rate = new Map<string, number>();
  clock = () => new Date();

  async upsertUserFromGoogle(id: GoogleIdentityInput) {
    let userId = this.googleSubs.get(id.sub);
    if (!userId) {
      userId = [...this.profiles.values()].find((p) => p.email === id.email)?.id ?? randomUUID();
      this.googleSubs.set(id.sub, userId);
    }
    const p = { id: userId, email: id.email, name: id.name, avatarUrl: id.picture };
    this.profiles.set(userId, p);
    return p;
  }
  async getProfile(id: string) {
    return this.profiles.get(id) ?? null;
  }
  async saveRefreshToken(userId: string, ciphertext: string) {
    this.creds.set(userId, { ciphertext, revokedAt: null });
  }
  async getRefreshToken(userId: string) {
    return this.creds.get(userId) ?? null;
  }
  async markCredentialsRevoked(userId: string) {
    const c = this.creds.get(userId);
    if (c) c.revokedAt = this.clock().toISOString();
  }
  async createAuthCode(row: AuthCodeRow) {
    this.codes.set(row.codeHash, { ...row, usedAt: null });
  }
  async consumeAuthCode(codeHash: string, now: Date) {
    const c = this.codes.get(codeHash);
    if (!c || c.usedAt || new Date(c.expiresAt) <= now) return null;
    c.usedAt = now.toISOString();
    return c;
  }
  async createSession(userId: string, expiresAt: Date) {
    const s = { id: randomUUID(), userId, expiresAt: expiresAt.toISOString(), revokedAt: null };
    this.sessions.set(s.id, s);
    return s;
  }
  async getSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async revokeSession(id: string) {
    const s = this.sessions.get(id);
    if (s) s.revokedAt = this.clock().toISOString();
  }
  async getFolders(userId: string) {
    return { ...(this.folders.get(userId) ?? {}) };
  }
  async upsertFolder(userId: string, type: FolderType, driveFolderId: string) {
    this.folders.set(userId, { ...(this.folders.get(userId) ?? {}), [type]: driveFolderId });
  }
  async listAssets(userId: string, f: { type?: string; q?: string }) {
    return [...this.assets.values()]
      .filter((a) => a.userId === userId && (!f.type || a.mediaType === f.type) && (!f.q || a.filename.toLowerCase().includes(f.q.toLowerCase())))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getAsset(id: string) {
    return this.assets.get(id) ?? null;
  }
  async getAssetByDriveId(userId: string, driveFileId: string) {
    return [...this.assets.values()].find((a) => a.userId === userId && a.driveFileId === driveFileId) ?? null;
  }
  async insertAsset(a: NewAsset) {
    if (await this.getAssetByDriveId(a.userId, a.driveFileId)) throw new Error('duplicate key value violates unique constraint');
    const now = this.clock().toISOString();
    const row: AssetRow = { ...a, id: randomUUID(), status: 'available', isDrivePublic: false, createdAt: now, updatedAt: now };
    this.assets.set(row.id, row);
    return row;
  }
  async updateAsset(id: string, patch: Partial<AssetRow>) {
    const a = this.assets.get(id);
    if (!a) throw new Error('not found');
    Object.assign(a, patch, { updatedAt: this.clock().toISOString() });
    return a;
  }
  async deleteAsset(id: string) {
    this.assets.delete(id);
    for (const [k, s] of this.shares) if (s.assetId === id) this.shares.delete(k); // ON DELETE CASCADE
  }
  async listShares(assetId: string) {
    return [...this.shares.values()].filter((s) => s.assetId === assetId);
  }
  async getShare(id: string) {
    return this.shares.get(id) ?? null;
  }
  async getShareByHash(h: string) {
    return [...this.shares.values()].find((s) => s.tokenHash === h) ?? null;
  }
  async insertShare(s: NewShare) {
    const asset = this.assets.get(s.assetId);
    if (!asset || asset.userId !== s.userId) throw new Error('share link owner must own the asset'); // mirrors SQL trigger
    const row: ShareRow = { ...s, id: randomUUID(), isActive: true, revokedAt: null, viewCount: 0, createdAt: this.clock().toISOString() };
    this.shares.set(row.id, row);
    return row;
  }
  async updateShare(id: string, patch: Partial<ShareRow>) {
    const s = this.shares.get(id);
    if (s) Object.assign(s, patch);
  }
  async incrementShareView(id: string) {
    const s = this.shares.get(id);
    if (s) s.viewCount++;
  }
  async listExpiredActiveShares(now: Date) {
    return [...this.shares.values()].filter((s) => s.isActive && s.expiresAt && new Date(s.expiresAt) < now);
  }
  async logActivity(userId: string, action: string, assetId: string | null) {
    this.activity.push({ userId, action, assetId });
  }
  async rateLimitHit(key: string, windowSeconds: number, max: number) {
    const w = Math.floor(this.clock().getTime() / 1000 / windowSeconds);
    const k = `${key}:${w}`;
    const n = (this.rate.get(k) ?? 0) + 1;
    this.rate.set(k, n);
    return n <= max;
  }
}
