import { FOLDER_FOR_MEDIA, type MediaAsset, type MediaType, type StorageQuota } from '@snapshare/shared';
import { getDriveAccessToken } from '@/features/authentication/auth';
import { api } from '@/services/api';
import { deleteUploadSession, getCapture, getUploadSession, saveUploadSession, updateCapture, type CaptureRecord } from '@/services/db';
import { DriveError, resumableUpload } from './upload';

type FolderMap = Record<'root' | 'screenshots' | 'edited' | 'videos', string>;

let folderCache: { userKey: string; folders: FolderMap } | null = null;

/** Ensures SnapShare/{Screenshots,Edited Images,Videos} exist (backend finds existing ones before creating). */
export async function ensureFolders(): Promise<FolderMap> {
  const res = await api<{ userId: string; folders: FolderMap }>('/api/drive/folders', { method: 'POST' });
  folderCache = { userKey: res.userId, folders: res.folders };
  return res.folders;
}

export function mediaTypeForCapture(c: Pick<CaptureRecord, 'kind'>): MediaType {
  return c.kind;
}

export interface UploadProgress {
  sent: number;
  total: number;
}

/**
 * Uploads a local capture to the user's Drive and registers its metadata with the backend.
 * For edited images the original screenshot is uploaded first so the parent link is preserved.
 */
export async function uploadCapture(captureId: string, onProgress?: (p: UploadProgress) => void, signal?: AbortSignal): Promise<MediaAsset> {
  const capture = await getCapture(captureId);
  if (!capture) throw new Error('Capture not found on this device');
  if (capture.cloud) {
    return api<MediaAsset>(`/api/assets/${capture.cloud.assetId}`);
  }
  let parentAssetId: string | null = null;
  if (capture.kind === 'edited' && capture.parentId) {
    const parent = await getCapture(capture.parentId);
    if (parent) parentAssetId = parent.cloud?.assetId ?? (await uploadCapture(parent.id, undefined, signal)).id;
  }
  const mediaType = mediaTypeForCapture(capture);
  const folders = folderCache?.folders ?? (await ensureFolders());
  const ext = capture.mimeType === 'video/webm' ? 'webm' : capture.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const name = capture.filename.toLowerCase().endsWith(`.${ext}`) ? capture.filename : `${capture.filename}.${ext}`;

  const doUpload = (folderId: string) =>
    resumableUpload(
      capture.blob,
      {
        name,
        mimeType: capture.mimeType,
        mediaType,
        folderId,
        captureId,
        signal,
        onProgress: (sent, total) => onProgress?.({ sent, total }),
      },
      {
        fetch: (...a) => fetch(...a),
        getToken: getDriveAccessToken,
        loadSession: async () => (await getUploadSession(captureId))?.sessionUrl ?? null,
        saveSession: (url) => saveUploadSession({ captureId, sessionUrl: url, createdAt: Date.now() }),
        clearSession: () => deleteUploadSession(captureId),
      },
    );

  let file;
  try {
    file = await doUpload(folders[FOLDER_FOR_MEDIA[mediaType]]);
  } catch (e) {
    // Folder may have been deleted by the user in Drive: refresh folder ids once and retry.
    if (e instanceof DriveError && e.code === 'server' && /parent|not found|file not found/i.test(e.message)) {
      const fresh = await ensureFolders();
      file = await doUpload(fresh[FOLDER_FOR_MEDIA[mediaType]]);
    } else throw e;
  }

  const asset = await api<MediaAsset>('/api/assets', {
    body: {
      driveFileId: file.id,
      filename: name,
      mediaType,
      mimeType: capture.mimeType,
      size: capture.blob.size,
      width: capture.width,
      height: capture.height,
      durationMs: capture.durationMs,
      parentAssetId,
    },
  });
  await updateCapture(captureId, { cloud: { assetId: asset.id, driveFileId: file.id, uploadedAt: Date.now() } });
  return asset;
}

export function getStorageQuota(): Promise<StorageQuota> {
  return api<StorageQuota>('/api/drive/storage');
}
