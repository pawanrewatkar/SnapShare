import type { MediaType } from '@snapshare/shared';
import type { CaptureMeta } from '@/services/db';
import { drive, type DriveFile } from '@/features/drive/driveApi';
import { ensureFolders } from '@/features/drive/driveService';

export type Category = 'all' | MediaType;

export interface GalleryItem {
  key: string;
  source: 'cloud' | 'local';
  /** Drive file id for cloud items, capture id for local items. */
  id: string;
  filename: string;
  mediaType: MediaType;
  mimeType: string;
  size: number;
  createdAt: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** 'missing' = uploaded by this account but deleted/trashed in Drive. */
  status: 'available' | 'missing';
  file?: DriveFile;
  local?: CaptureMeta;
}

/** Lists the signed-in account's SnapShare files straight from Google Drive (Drive is the source of truth). */
export async function listDriveFiles(): Promise<DriveFile[]> {
  const f = await ensureFolders();
  const [shots, videos] = await Promise.all([drive.listFolder(f.screenshots), drive.listFolder(f.videos)]);
  return [...shots, ...videos];
}

export function mediaTypeOf(f: DriveFile): MediaType {
  const t = f.appProperties?.mediaType;
  if (t === 'edited' || t === 'screenshot' || t === 'video') return t;
  return f.mimeType.startsWith('video/') ? 'video' : 'screenshot';
}

/**
 * Merges Drive files with local captures for the current account only.
 * Local captures uploaded by another account are hidden; ones uploaded by this account but no
 * longer in Drive are shown as "missing" (reconciliation).
 */
export function mergeItems(files: DriveFile[], local: CaptureMeta[], category: Category, q: string, source: 'all' | 'cloud' | 'local', accountId: string | null): GalleryItem[] {
  const query = q.trim().toLowerCase();
  const items: GalleryItem[] = [];
  const driveIds = new Set(files.map((f) => f.id));
  if (source !== 'local')
    for (const f of files)
      items.push({
        key: `c:${f.id}`,
        source: 'cloud',
        id: f.id,
        filename: f.name,
        mediaType: mediaTypeOf(f),
        mimeType: f.mimeType,
        size: Number(f.size ?? 0),
        createdAt: f.createdTime ? Date.parse(f.createdTime) : 0,
        width: f.imageMediaMetadata?.width ?? f.videoMediaMetadata?.width ?? null,
        height: f.imageMediaMetadata?.height ?? f.videoMediaMetadata?.height ?? null,
        durationMs: f.videoMediaMetadata?.durationMillis ? Number(f.videoMediaMetadata.durationMillis) : null,
        status: 'available',
        file: f,
      });
  if (source !== 'cloud')
    for (const l of local) {
      let status: GalleryItem['status'] = 'available';
      if (l.cloud) {
        if (!l.cloud.accountId || l.cloud.accountId !== accountId) {
          if (l.cloud.accountId) continue; // belongs to another Google account
        } else if (driveIds.has(l.cloud.driveFileId)) continue; // shown as the Drive item
        else status = 'missing';
      }
      items.push({ key: `l:${l.id}`, source: 'local', id: l.id, filename: l.filename, mediaType: l.kind, mimeType: l.mimeType, size: l.size, createdAt: l.createdAt, width: l.width, height: l.height, durationMs: l.durationMs, status, local: l });
    }
  return items
    .filter((i) => category === 'all' || i.mediaType === category)
    .filter((i) => !query || i.filename.toLowerCase().includes(query))
    .sort((a, b) => b.createdAt - a.createdAt);
}
