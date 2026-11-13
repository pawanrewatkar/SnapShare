/**
 * Types and constants shared by the SnapShare extension and web backend.
 * Keep this module dependency-free so both bundlers can consume it as source.
 */

export type MediaType = 'screenshot' | 'edited' | 'video';
export type FolderType = 'root' | 'screenshots' | 'edited' | 'videos';
export type ShareAccessType = 'public' | 'restricted';
export type AssetStatus = 'available' | 'missing';

export const MEDIA_TYPES: readonly MediaType[] = ['screenshot', 'edited', 'video'] as const;

export const DRIVE_FOLDER_NAMES: Record<FolderType, string> = {
  root: 'SnapShare',
  screenshots: 'Screenshots',
  edited: 'Edited Images',
  videos: 'Videos',
};

export const FOLDER_FOR_MEDIA: Record<MediaType, Exclude<FolderType, 'root'>> = {
  screenshot: 'screenshots',
  edited: 'edited',
  video: 'videos',
};

/** MIME types SnapShare is allowed to upload / register, per media type. */
export const ALLOWED_MIME: Record<MediaType, readonly string[]> = {
  screenshot: ['image/png', 'image/jpeg', 'image/webp'],
  edited: ['image/png', 'image/jpeg', 'image/webp'],
  video: ['video/webm'],
};

/** Upper bounds enforced client- and server-side. */
export const MAX_SIZE_BYTES: Record<MediaType, number> = {
  screenshot: 100 * 1024 * 1024,
  edited: 100 * 1024 * 1024,
  video: 4 * 1024 * 1024 * 1024,
};

export const MAX_FILENAME_LENGTH = 200;

/** Minimal Drive scope: drive.file grants list/rename/delete/share on files created by this app only. */
export const GOOGLE_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'] as const;

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface MediaAsset {
  id: string;
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

export interface ShareLink {
  id: string;
  assetId: string;
  accessType: ShareAccessType;
  allowDownload: boolean;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  revokedAt: string | null;
  /** Only returned once, at creation. Never stored server-side in raw form. */
  url?: string;
}

export interface DrivePermission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone';
  role: string;
  emailAddress?: string;
  displayName?: string;
}

export interface PublicShareView {
  status: 'ok' | 'expired' | 'revoked' | 'not_found' | 'missing';
  filename?: string;
  mediaType?: MediaType;
  mimeType?: string;
  size?: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  createdAt?: string;
  expiresAt?: string | null;
  allowDownload?: boolean;
  accessType?: ShareAccessType;
  ownerName?: string | null;
}

export interface StorageQuota {
  limit: number | null;
  usage: number;
  usageInDrive: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Error codes shared between client and server so the UI can react precisely. */
export type ApiErrorCode =
  | 'unauthenticated'
  | 'reauth_required'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'rate_limited'
  | 'drive_quota'
  | 'drive_missing'
  | 'drive_error'
  | 'conflict'
  | 'server_error';

export function isMediaType(v: unknown): v is MediaType {
  return typeof v === 'string' && (MEDIA_TYPES as readonly string[]).includes(v);
}

/** Strip path separators and control chars; collapse whitespace; enforce length. */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
  const limited = cleaned.slice(0, MAX_FILENAME_LENGTH);
  return limited.length > 0 && limited !== '.' && limited !== '..' ? limited : 'untitled';
}

export function validateUpload(mediaType: MediaType, mimeType: string, size: number): string | null {
  if (!ALLOWED_MIME[mediaType].includes(mimeType)) return `Unsupported file type ${mimeType} for ${mediaType}`;
  if (!Number.isFinite(size) || size <= 0) return 'File is empty';
  if (size > MAX_SIZE_BYTES[mediaType]) return `File exceeds the ${Math.round(MAX_SIZE_BYTES[mediaType] / 1024 / 1024)} MB limit`;
  return null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
