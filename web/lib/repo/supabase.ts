import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FolderType } from '@snapshare/shared';
import { env } from '../env';
import type { AssetRow, AuthCodeRow, GoogleIdentityInput, NewAsset, NewShare, Profile, Repo, SessionRow, ShareRow } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const toProfile = (r: Row): Profile => ({ id: r.id, email: r.email, name: r.name, avatarUrl: r.avatar_url });
const toAsset = (r: Row): AssetRow => ({
  id: r.id,
  userId: r.user_id,
  driveFileId: r.drive_file_id,
  filename: r.filename,
  mediaType: r.media_type,
  mimeType: r.mime_type,
  size: Number(r.size),
  width: r.width,
  height: r.height,
  durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  parentAssetId: r.parent_asset_id,
  status: r.status,
  isDrivePublic: r.is_drive_public,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toShare = (r: Row): ShareRow => ({
  id: r.id,
  assetId: r.asset_id,
  userId: r.user_id,
  tokenHash: r.token_hash,
  tokenCiphertext: r.token_ciphertext,
  accessType: r.access_type,
  allowDownload: r.allow_download,
  expiresAt: r.expires_at,
  isActive: r.is_active,
  revokedAt: r.revoked_at,
  drivePermissionId: r.drive_permission_id,
  viewCount: r.view_count,
  createdAt: r.created_at,
});

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`Database error: ${res.error.message}`);
  return res.data;
}

/** Service-role repository. Server-only: the service key bypasses RLS, so every query filters by owner explicitly. */
export class SupabaseRepo implements Repo {
  private db: SupabaseClient;
  constructor(client?: SupabaseClient) {
    this.db = client ?? createClient(env().SUPABASE_URL, env().SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async upsertUserFromGoogle(id: GoogleIdentityInput): Promise<Profile> {
    const link = check(await this.db.from('google_accounts').select('user_id').eq('google_sub', id.sub).maybeSingle());
    let userId: string;
    if (link) {
      userId = link.user_id;
      check(await this.db.from('profiles').update({ email: id.email, name: id.name, avatar_url: id.picture }).eq('id', userId));
      check(await this.db.from('google_accounts').update({ email: id.email, scopes: id.scopes }).eq('user_id', userId));
    } else {
      const p = check(await this.db.from('profiles').upsert({ email: id.email, name: id.name, avatar_url: id.picture }, { onConflict: 'email' }).select().single());
      userId = p.id;
      check(await this.db.from('google_accounts').upsert({ user_id: userId, google_sub: id.sub, email: id.email, scopes: id.scopes }, { onConflict: 'user_id' }));
    }
    return (await this.getProfile(userId))!;
  }

  async getProfile(id: string) {
    const r = check(await this.db.from('profiles').select('*').eq('id', id).maybeSingle());
    return r ? toProfile(r) : null;
  }

  async saveRefreshToken(userId: string, ciphertext: string) {
    check(await this.db.from('google_credentials').upsert({ user_id: userId, refresh_token_ciphertext: ciphertext, revoked_at: null }, { onConflict: 'user_id' }));
  }

  async getRefreshToken(userId: string) {
    const r = check(await this.db.from('google_credentials').select('refresh_token_ciphertext, revoked_at').eq('user_id', userId).maybeSingle());
    return r ? { ciphertext: r.refresh_token_ciphertext as string, revokedAt: r.revoked_at as string | null } : null;
  }

  async markCredentialsRevoked(userId: string) {
    check(await this.db.from('google_credentials').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId));
  }

  async createAuthCode(row: AuthCodeRow) {
    check(await this.db.from('auth_codes').insert({ code_hash: row.codeHash, user_id: row.userId, code_challenge: row.codeChallenge, redirect_uri: row.redirectUri, expires_at: row.expiresAt }));
  }

  async consumeAuthCode(codeHash: string, now: Date) {
    const r = check(
      await this.db.from('auth_codes').update({ used_at: now.toISOString() }).eq('code_hash', codeHash).is('used_at', null).gt('expires_at', now.toISOString()).select().maybeSingle(),
    );
    return r ? { codeHash: r.code_hash, userId: r.user_id, codeChallenge: r.code_challenge, redirectUri: r.redirect_uri, expiresAt: r.expires_at } : null;
  }

  async createSession(userId: string, expiresAt: Date, userAgent: string | null): Promise<SessionRow> {
    const r = check(await this.db.from('sessions').insert({ user_id: userId, expires_at: expiresAt.toISOString(), user_agent: userAgent?.slice(0, 500) ?? null }).select().single());
    return { id: r.id, userId: r.user_id, expiresAt: r.expires_at, revokedAt: r.revoked_at };
  }

  async getSession(id: string) {
    const r = check(await this.db.from('sessions').select('*').eq('id', id).maybeSingle());
    return r ? { id: r.id, userId: r.user_id, expiresAt: r.expires_at, revokedAt: r.revoked_at } : null;
  }

  async revokeSession(id: string) {
    check(await this.db.from('sessions').update({ revoked_at: new Date().toISOString() }).eq('id', id));
  }

  async getFolders(userId: string) {
    const rows = check(await this.db.from('drive_folders').select('folder_type, drive_folder_id').eq('user_id', userId)) as Row[];
    return Object.fromEntries(rows.map((r) => [r.folder_type, r.drive_folder_id])) as Partial<Record<FolderType, string>>;
  }

  async upsertFolder(userId: string, type: FolderType, driveFolderId: string) {
    check(await this.db.from('drive_folders').upsert({ user_id: userId, folder_type: type, drive_folder_id: driveFolderId }, { onConflict: 'user_id,folder_type' }));
  }

  async listAssets(userId: string, f: { type?: string; q?: string; limit?: number }) {
    let q = this.db.from('media_assets').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(f.limit ?? 500);
    if (f.type) q = q.eq('media_type', f.type);
    if (f.q) q = q.ilike('filename', `%${f.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    return (check(await q) as Row[]).map(toAsset);
  }

  async getAsset(id: string) {
    const r = check(await this.db.from('media_assets').select('*').eq('id', id).maybeSingle());
    return r ? toAsset(r) : null;
  }

  async getAssetByDriveId(userId: string, driveFileId: string) {
    const r = check(await this.db.from('media_assets').select('*').eq('user_id', userId).eq('drive_file_id', driveFileId).maybeSingle());
    return r ? toAsset(r) : null;
  }

  async insertAsset(a: NewAsset) {
    const r = check(
      await this.db
        .from('media_assets')
        .insert({
          user_id: a.userId,
          drive_file_id: a.driveFileId,
          filename: a.filename,
          media_type: a.mediaType,
          mime_type: a.mimeType,
          size: a.size,
          width: a.width,
          height: a.height,
          duration_ms: a.durationMs,
          parent_asset_id: a.parentAssetId,
        })
        .select()
        .single(),
    );
    return toAsset(r);
  }

  async updateAsset(id: string, patch: Partial<Pick<AssetRow, 'filename' | 'status' | 'isDrivePublic'>>) {
    const row: Row = { last_checked_at: new Date().toISOString() };
    if (patch.filename !== undefined) row.filename = patch.filename;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.isDrivePublic !== undefined) row.is_drive_public = patch.isDrivePublic;
    const r = check(await this.db.from('media_assets').update(row).eq('id', id).select().single());
    if (!r) throw new Error('Asset not found');
    return toAsset(r);
  }

  async deleteAsset(id: string) {
    check(await this.db.from('media_assets').delete().eq('id', id));
  }

  async listShares(assetId: string) {
    return (check(await this.db.from('share_links').select('*').eq('asset_id', assetId).order('created_at', { ascending: false })) as Row[]).map(toShare);
  }

  async getShare(id: string) {
    const r = check(await this.db.from('share_links').select('*').eq('id', id).maybeSingle());
    return r ? toShare(r) : null;
  }

  async getShareByHash(tokenHash: string) {
    const r = check(await this.db.from('share_links').select('*').eq('token_hash', tokenHash).maybeSingle());
    return r ? toShare(r) : null;
  }

  async insertShare(s: NewShare) {
    const r = check(
      await this.db
        .from('share_links')
        .insert({
          asset_id: s.assetId,
          user_id: s.userId,
          token_hash: s.tokenHash,
          token_ciphertext: s.tokenCiphertext,
          access_type: s.accessType,
          allow_download: s.allowDownload,
          expires_at: s.expiresAt,
          drive_permission_id: s.drivePermissionId,
        })
        .select()
        .single(),
    );
    return toShare(r);
  }

  async updateShare(id: string, patch: Partial<Pick<ShareRow, 'isActive' | 'revokedAt' | 'drivePermissionId'>>) {
    const row: Row = {};
    if (patch.isActive !== undefined) row.is_active = patch.isActive;
    if (patch.revokedAt !== undefined) row.revoked_at = patch.revokedAt;
    if (patch.drivePermissionId !== undefined) row.drive_permission_id = patch.drivePermissionId;
    check(await this.db.from('share_links').update(row).eq('id', id));
  }

  async incrementShareView(id: string) {
    check(await this.db.rpc('increment_share_view', { p_id: id }));
  }

  async listExpiredActiveShares(now: Date, limit: number) {
    return (check(await this.db.from('share_links').select('*').eq('is_active', true).lt('expires_at', now.toISOString()).limit(limit)) as Row[]).map(toShare);
  }

  async logActivity(userId: string, action: string, assetId: string | null, metadata: Record<string, unknown> = {}) {
    const res = await this.db.from('activity_logs').insert({ user_id: userId, action, asset_id: assetId, metadata });
    if (res.error) console.error('[activity] failed to log', res.error.message);
  }

  async rateLimitHit(key: string, windowSeconds: number, max: number) {
    const res = await this.db.rpc('rate_limit_hit', { p_key: key, p_window_seconds: windowSeconds, p_max: max });
    if (res.error) {
      console.error('[ratelimit] failing open', res.error.message);
      return true;
    }
    return res.data === true;
  }
}
