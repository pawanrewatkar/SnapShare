import type { AssetStatus, FolderType, MediaType, ShareAccessType } from '@snapshare/shared';

export interface Profile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface AssetRow {
  id: string;
  userId: string;
  driveFileId: string;
  filename: string;
  mediaType: MediaType;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  parentAssetId: string | null;
  status: AssetStatus;
  isDrivePublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NewAsset = Omit<AssetRow, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'isDrivePublic'>;

export interface ShareRow {
  id: string;
  assetId: string;
  userId: string;
  tokenHash: string;
  tokenCiphertext: string;
  accessType: ShareAccessType;
  allowDownload: boolean;
  expiresAt: string | null;
  isActive: boolean;
  revokedAt: string | null;
  drivePermissionId: string | null;
  viewCount: number;
  createdAt: string;
}

export type NewShare = Omit<ShareRow, 'id' | 'createdAt' | 'isActive' | 'revokedAt' | 'viewCount'>;

export interface SessionRow {
  id: string;
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AuthCodeRow {
  codeHash: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: string;
}

export interface GoogleIdentityInput {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  scopes: string[];
}

export interface Repo {
  upsertUserFromGoogle(identity: GoogleIdentityInput): Promise<Profile>;
  getProfile(id: string): Promise<Profile | null>;

  saveRefreshToken(userId: string, ciphertext: string): Promise<void>;
  getRefreshToken(userId: string): Promise<{ ciphertext: string; revokedAt: string | null } | null>;
  markCredentialsRevoked(userId: string): Promise<void>;

  createAuthCode(row: AuthCodeRow): Promise<void>;
  /** Atomically marks the code used and returns it, or null if unknown/used/expired. */
  consumeAuthCode(codeHash: string, now: Date): Promise<AuthCodeRow | null>;

  createSession(userId: string, expiresAt: Date, userAgent: string | null): Promise<SessionRow>;
  getSession(id: string): Promise<SessionRow | null>;
  revokeSession(id: string): Promise<void>;

  getFolders(userId: string): Promise<Partial<Record<FolderType, string>>>;
  upsertFolder(userId: string, type: FolderType, driveFolderId: string): Promise<void>;

  listAssets(userId: string, filter: { type?: MediaType; q?: string; limit?: number }): Promise<AssetRow[]>;
  getAsset(id: string): Promise<AssetRow | null>;
  getAssetByDriveId(userId: string, driveFileId: string): Promise<AssetRow | null>;
  insertAsset(a: NewAsset): Promise<AssetRow>;
  updateAsset(id: string, patch: Partial<Pick<AssetRow, 'filename' | 'status' | 'isDrivePublic'>>): Promise<AssetRow>;
  deleteAsset(id: string): Promise<void>;

  listShares(assetId: string): Promise<ShareRow[]>;
  getShare(id: string): Promise<ShareRow | null>;
  getShareByHash(tokenHash: string): Promise<ShareRow | null>;
  insertShare(s: NewShare): Promise<ShareRow>;
  updateShare(id: string, patch: Partial<Pick<ShareRow, 'isActive' | 'revokedAt' | 'drivePermissionId'>>): Promise<void>;
  incrementShareView(id: string): Promise<void>;
  listExpiredActiveShares(now: Date, limit: number): Promise<ShareRow[]>;

  logActivity(userId: string, action: string, assetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
  /** Returns true if the request is allowed (count within the window is <= max). */
  rateLimitHit(key: string, windowSeconds: number, max: number): Promise<boolean>;
}
