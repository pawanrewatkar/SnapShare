import type { MediaType } from '@snapshare/shared';
import { platform } from '@/browser';
import { getDriveAccessToken } from '@/features/authentication/auth';
import { getSession, AuthError } from '@/services/api';
import { deleteUploadSession, getCapture, getUploadSession, saveUploadSession, updateCapture, type CaptureRecord } from '@/services/db';
import { drive, type DriveFile } from './driveApi';
import { resumableUpload } from './upload';

/** My Drive/SnapShare/{Screenshots,Videos}. Edited screenshots also go to Screenshots. */
export const FOLDER_NAMES = { root: 'SnapShare', screenshots: 'Screenshots', videos: 'Videos' } as const;
export type FolderKey = keyof typeof FOLDER_NAMES;
export type FolderMap = Record<FolderKey, string>;

export const folderForMedia = (m: MediaType): Exclude<FolderKey, 'root'> => (m === 'video' ? 'videos' : 'screenshots');

async function requireAccountId(): Promise<string> {
  const s = await getSession();
  if (!s) throw new AuthError('unauthenticated', 'Please sign in with Google first.');
  return s.user.id;
}

const folderKey = (accountId: string) => `driveFolders:${accountId}`;
const inflight = new Map<string, Promise<FolderMap>>();

/**
 * Finds or creates the folder tree for the signed-in account. Stored ids are re-validated; when a
 * folder is missing we search (oldest match wins) before creating, and calls are de-duplicated so
 * concurrent uploads never create duplicate folders.
 */
export function ensureFolders(): Promise<FolderMap> {
  return requireAccountId().then((accountId) => {
    const running = inflight.get(accountId);
    if (running) return running;
    const p = (async () => {
      const stored = (await platform.storage.local.get<Partial<FolderMap>>(folderKey(accountId))) ?? {};
      const result = {} as FolderMap;
      const resolve = async (k: FolderKey, parent: string) => {
        const id = stored[k];
        if (id) {
          const f = await drive.getFileIfExists(id, 'id,trashed,parents');
          if (f && (k === 'root' || f.parents?.includes(parent))) return id;
        }
        const found = await drive.findFolders(FOLDER_NAMES[k], parent);
        return found[0]?.id ?? (await drive.createFolder(FOLDER_NAMES[k], parent)).id;
      };
      result.root = await resolve('root', 'root');
      result.screenshots = await resolve('screenshots', result.root);
      result.videos = await resolve('videos', result.root);
      await platform.storage.local.set(folderKey(accountId), result);
      return result;
    })().finally(() => inflight.delete(accountId));
    inflight.set(accountId, p);
    return p;
  });
}

export async function cachedFolders(): Promise<FolderMap | null> {
  const s = await getSession();
  return s ? ((await platform.storage.local.get<FolderMap>(folderKey(s.user.id))) ?? null) : null;
}

export interface UploadProgress {
  sent: number;
  total: number;
}

/** Uploads a local capture into the signed-in user's Drive. Edited images upload their original first. */
export async function uploadCapture(captureId: string, onProgress?: (p: UploadProgress) => void, signal?: AbortSignal): Promise<DriveFile> {
  const accountId = await requireAccountId();
  const capture = await getCapture(captureId);
  if (!capture) throw new Error('Capture not found on this device');
  if (capture.cloud && capture.cloud.accountId === accountId) {
    const existing = await drive.getFileIfExists(capture.cloud.driveFileId, 'id,name,mimeType,size,webViewLink,trashed');
    if (existing) return existing;
  }
  if (capture.kind === 'edited' && capture.parentId) {
    const parent = await getCapture(capture.parentId);
    if (parent && parent.cloud?.accountId !== accountId) await uploadCapture(parent.id, undefined, signal).catch(() => undefined);
  }
  const mediaType: MediaType = capture.kind;
  const folders = await ensureFolders();
  const name = withExtension(capture);
  const file = await resumableUpload(
    capture.blob,
    { name, mimeType: capture.mimeType, mediaType, folderId: folders[folderForMedia(mediaType)], captureId, signal, onProgress: (sent, total) => onProgress?.({ sent, total }) },
    {
      fetch: (...a) => fetch(...a),
      getToken: getDriveAccessToken,
      loadSession: async () => {
        const s = await getUploadSession(captureId);
        return s && s.accountId === accountId ? s.sessionUrl : null;
      },
      saveSession: (url) => saveUploadSession({ captureId, sessionUrl: url, createdAt: Date.now(), accountId }),
      clearSession: () => deleteUploadSession(captureId),
    },
  );
  await updateCapture(captureId, { cloud: { assetId: file.id, driveFileId: file.id, uploadedAt: Date.now(), accountId } });
  return { id: file.id, name: file.name, mimeType: file.mimeType, size: String(file.size) };
}

function withExtension(c: CaptureRecord): string {
  const ext = c.mimeType === 'video/webm' ? 'webm' : c.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  return c.filename.toLowerCase().endsWith(`.${ext}`) ? c.filename : `${c.filename}.${ext}`;
}

export function getStorageQuota() {
  return drive.about();
}
