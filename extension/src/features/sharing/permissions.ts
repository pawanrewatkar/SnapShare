import type { DrivePermission } from '@/features/drive/driveApi';

/**
 * Pure sharing-state analysis for ONE file. Permissions granted on parent folders (SnapShare/,
 * Screenshots/, Videos/) are inherited by every file inside them in My Drive, so they are reported
 * as exposures and never hidden behind a "Private" label.
 */
export interface FolderPermissions {
  folderName: string;
  folderId: string;
  permissions: DrivePermission[];
}

export interface SharingState {
  /** Only the owner can access the file (no direct or inherited grants). */
  isPrivate: boolean;
  /** Anyone with the link can view — directly on the file or inherited from a folder. */
  anyoneWithLink: boolean;
  /** Grants made directly on this file (removable here). */
  direct: DrivePermission[];
  /** Grants coming from shared parent folders (must be removed on the folder). */
  inherited: (DrivePermission & { folderName: string; folderId: string })[];
  summary: string;
}

const nonOwner = (p: DrivePermission) => p.role !== 'owner';
const key = (p: DrivePermission) => `${p.type}:${p.id}`;

export function analyzeSharing(filePerms: DrivePermission[], folders: FolderPermissions[]): SharingState {
  const inherited: SharingState['inherited'] = [];
  const inheritedKeys = new Set<string>();
  for (const f of folders)
    for (const p of f.permissions.filter(nonOwner)) {
      inherited.push({ ...p, folderName: f.folderName, folderId: f.folderId });
      inheritedKeys.add(key(p));
    }
  // In My Drive, a folder grant also appears on each child with the same permission id.
  const direct = filePerms.filter(nonOwner).filter((p) => !inheritedKeys.has(key(p)));
  const anyoneWithLink = direct.some((p) => p.type === 'anyone') || inherited.some((p) => p.type === 'anyone');
  const isPrivate = direct.length === 0 && inherited.length === 0;
  let summary: string;
  if (isPrivate) summary = 'Private — only you can open this file.';
  else {
    const parts: string[] = [];
    if (anyoneWithLink) parts.push('anyone with the link can view');
    const people = [...direct, ...inherited].filter((p) => p.type !== 'anyone').map((p) => p.emailAddress ?? p.domain ?? p.displayName ?? p.type);
    if (people.length) parts.push(`shared with ${[...new Set(people)].join(', ')}`);
    summary = parts.join('; ');
    summary = summary.charAt(0).toUpperCase() + summary.slice(1) + (inherited.length ? ' (partly through a shared SnapShare folder)' : '') + '.';
  }
  return { isPrivate, anyoneWithLink, direct, inherited, summary };
}

export function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) && e.length <= 254;
}

/** Original Google Drive URL of a single file (never a folder URL). */
export function fileUrl(fileId: string, webViewLink?: string | null): string {
  if (webViewLink && /^https:\/\/drive\.google\.com\/file\/d\//.test(webViewLink)) return webViewLink;
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view?usp=sharing`;
}
