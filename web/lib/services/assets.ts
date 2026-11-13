import { z } from 'zod';
import { ALLOWED_MIME, DRIVE_FOLDER_NAMES, FOLDER_FOR_MEDIA, MAX_FILENAME_LENGTH, MEDIA_TYPES, sanitizeFilename, validateUpload, type DrivePermission, type FolderType, type MediaAsset } from '@snapshare/shared';
import { repo } from '../repo';
import type { AssetRow } from '../repo/types';
import { driveFor, mapDriveError } from '../driveAccess';
import { DriveApiError } from '../drive';
import { badRequest, notFound } from '../http';

export function toPublicAsset(a: AssetRow): MediaAsset {
  return {
    id: a.id,
    driveFileId: a.driveFileId,
    filename: a.filename,
    mediaType: a.mediaType,
    mimeType: a.mimeType,
    size: a.size,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    parentAssetId: a.parentAssetId,
    status: a.status,
    isDrivePublic: a.isDrivePublic,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** Ownership check. Returns 404 (not 403) for other users' assets so existence isn't revealed. */
export async function getOwnedAsset(userId: string, assetId: string): Promise<AssetRow> {
  const a = await repo().getAsset(assetId);
  if (!a || a.userId !== userId) throw notFound('File not found');
  return a;
}

/** Finds or creates SnapShare/{Screenshots,Edited Images,Videos}, re-creating folders deleted in Drive. */
export async function ensureFolders(userId: string): Promise<Record<FolderType, string>> {
  const drive = await driveFor(userId);
  const known = await repo().getFolders(userId);
  const result = {} as Record<FolderType, string>;
  try {
    const resolve = async (type: FolderType, parent: string): Promise<string> => {
      const existingId = known[type];
      if (existingId) {
        const f = await drive.getFileIfExists(existingId, 'id,trashed,parents');
        if (f && (type === 'root' || f.parents?.includes(parent))) return existingId;
      }
      const found = await drive.findFolder(DRIVE_FOLDER_NAMES[type], parent);
      const id = found?.id ?? (await drive.createFolder(DRIVE_FOLDER_NAMES[type], parent)).id;
      await repo().upsertFolder(userId, type, id);
      return id;
    };
    result.root = await resolve('root', 'root');
    for (const t of ['screenshots', 'edited', 'videos'] as const) result[t] = await resolve(t, result.root);
  } catch (e) {
    mapDriveError(e, userId);
  }
  return result;
}

export const registerSchema = z.object({
  driveFileId: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
  filename: z.string().min(1).max(MAX_FILENAME_LENGTH * 2),
  mediaType: z.enum(MEDIA_TYPES as unknown as [string, ...string[]]),
  mimeType: z.string().max(100),
  size: z.number().int().positive(),
  width: z.number().int().positive().max(100_000).nullable().optional(),
  height: z.number().int().positive().max(1_000_000).nullable().optional(),
  durationMs: z.number().int().nonnegative().max(1000 * 60 * 60 * 24).nullable().optional(),
  parentAssetId: z.string().uuid().nullable().optional(),
});

/**
 * Registers metadata for a file the extension uploaded directly to Drive.
 * Verifies with Drive that the file exists, was created by SnapShare, sits in the user's SnapShare folder,
 * and matches the declared type/size — the client cannot register arbitrary Drive IDs.
 */
export async function registerAsset(userId: string, input: z.infer<typeof registerSchema>): Promise<AssetRow> {
  const mediaType = input.mediaType as AssetRow['mediaType'];
  const invalid = validateUpload(mediaType, input.mimeType, input.size);
  if (invalid) throw badRequest(invalid);
  if (input.parentAssetId) await getOwnedAsset(userId, input.parentAssetId);
  const existing = await repo().getAssetByDriveId(userId, input.driveFileId);
  if (existing) return existing;

  const drive = await driveFor(userId);
  let file;
  try {
    file = await drive.getFile(input.driveFileId);
  } catch (e) {
    mapDriveError(e, userId);
  }
  if (!file || file.trashed) throw badRequest('Uploaded file was not found in Google Drive');
  if (file.appProperties?.snapshare !== '1') throw badRequest('File was not uploaded by SnapShare');
  if (!ALLOWED_MIME[mediaType].includes(file.mimeType) || file.mimeType !== input.mimeType) throw badRequest('File type does not match');
  if (file.size && Number(file.size) !== input.size) throw badRequest('File size does not match');
  const folders = await repo().getFolders(userId);
  const expectedFolder = folders[FOLDER_FOR_MEDIA[mediaType]];
  if (expectedFolder && !file.parents?.includes(expectedFolder)) throw badRequest('File is not in your SnapShare folder');

  const asset = await repo().insertAsset({
    userId,
    driveFileId: input.driveFileId,
    filename: sanitizeFilename(input.filename),
    mediaType,
    mimeType: input.mimeType,
    size: input.size,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    parentAssetId: input.parentAssetId ?? null,
  });
  await repo().logActivity(userId, 'upload', asset.id, { mediaType, size: input.size });
  return asset;
}

export async function renameAsset(userId: string, assetId: string, rawName: string): Promise<AssetRow> {
  const asset = await getOwnedAsset(userId, assetId);
  const name = sanitizeFilename(rawName);
  const ext = asset.mimeType === 'video/webm' ? '.webm' : asset.mimeType === 'image/jpeg' ? '.jpg' : asset.mimeType === 'image/webp' ? '.webp' : '.png';
  const finalName = name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`.slice(0, MAX_FILENAME_LENGTH);
  try {
    await (await driveFor(userId)).rename(asset.driveFileId, finalName);
  } catch (e) {
    mapDriveError(e, userId);
  }
  const updated = await repo().updateAsset(assetId, { filename: finalName, status: 'available' });
  await repo().logActivity(userId, 'rename', assetId, { filename: finalName });
  return updated;
}

/** Deletes the actual Drive file (not just metadata); share links cascade-delete with the row. */
export async function deleteAssetFully(userId: string, assetId: string): Promise<void> {
  const asset = await getOwnedAsset(userId, assetId);
  try {
    await (await driveFor(userId)).delete(asset.driveFileId);
  } catch (e) {
    mapDriveError(e, userId);
  }
  await repo().deleteAsset(assetId);
  await repo().logActivity(userId, 'delete', null, { assetId, filename: asset.filename });
}

/** Marks assets whose Drive file was deleted/trashed outside SnapShare as missing (and restores ones that came back). */
export async function reconcileAssets(userId: string): Promise<{ checked: number; missing: number; restored: number }> {
  const assets = await repo().listAssets(userId, { limit: 1000 });
  const drive = await driveFor(userId);
  let missing = 0;
  let restored = 0;
  const queue = [...assets];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      let exists: boolean;
      try {
        exists = !!(await drive.getFileIfExists(a.driveFileId, 'id,trashed'));
      } catch (e) {
        mapDriveError(e, userId);
      }
      if (!exists && a.status !== 'missing') {
        await repo().updateAsset(a.id, { status: 'missing' });
        missing++;
      } else if (exists && a.status === 'missing') {
        await repo().updateAsset(a.id, { status: 'available' });
        restored++;
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return { checked: assets.length, missing, restored };
}

/* ---------- Drive permissions ---------- */

export interface PermissionsView {
  permissions: DrivePermission[];
  webViewLink: string | null;
}

export async function getPermissions(userId: string, assetId: string): Promise<PermissionsView> {
  const asset = await getOwnedAsset(userId, assetId);
  const drive = await driveFor(userId);
  try {
    const [perms, file] = await Promise.all([drive.listPermissions(asset.driveFileId), drive.getFile(asset.driveFileId, 'id,webViewLink')]);
    const isPublic = perms.some((p) => p.type === 'anyone');
    if (isPublic !== asset.isDrivePublic) await repo().updateAsset(assetId, { isDrivePublic: isPublic });
    return { permissions: perms, webViewLink: file.webViewLink ?? null };
  } catch (e) {
    if (e instanceof DriveApiError && e.isNotFound) await repo().updateAsset(assetId, { status: 'missing' });
    mapDriveError(e, userId);
  }
}

export const addPermissionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('anyone') }),
  z.object({ type: z.literal('user'), email: z.string().email().max(254), notify: z.boolean().optional() }),
]);

/** Explicit user action only: grants reader access to anyone-with-link or to a specific Google account. */
export async function addPermission(userId: string, assetId: string, input: z.infer<typeof addPermissionSchema>): Promise<PermissionsView> {
  const asset = await getOwnedAsset(userId, assetId);
  const drive = await driveFor(userId);
  try {
    if (input.type === 'anyone') {
      const existing = (await drive.listPermissions(asset.driveFileId)).find((p) => p.type === 'anyone');
      if (!existing) await drive.createPermission(asset.driveFileId, { type: 'anyone' });
      await repo().updateAsset(assetId, { isDrivePublic: true });
    } else {
      await drive.createPermission(asset.driveFileId, { type: 'user', emailAddress: input.email }, input.notify ?? false);
    }
  } catch (e) {
    mapDriveError(e, userId);
  }
  await repo().logActivity(userId, input.type === 'anyone' ? 'drive_public_on' : 'drive_share_user', assetId, input.type === 'user' ? { email: input.email } : {});
  return getPermissions(userId, assetId);
}

export async function removePermission(userId: string, assetId: string, permissionId: string): Promise<PermissionsView> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(permissionId)) throw badRequest('Invalid permission id');
  const asset = await getOwnedAsset(userId, assetId);
  const drive = await driveFor(userId);
  try {
    const perms = await drive.listPermissions(asset.driveFileId);
    const target = perms.find((p) => p.id === permissionId);
    if (!target) throw notFound('Permission not found');
    if (target.role === 'owner') throw badRequest('The owner permission cannot be removed');
    await drive.deletePermission(asset.driveFileId, permissionId);
    if (target.type === 'anyone') {
      await repo().updateAsset(assetId, { isDrivePublic: false });
      // Public SnapShare links depend on the Drive permission: deactivate them so state stays truthful.
      for (const s of await repo().listShares(assetId)) {
        if (s.isActive && s.accessType === 'public') await repo().updateShare(s.id, { isActive: false, revokedAt: new Date().toISOString(), drivePermissionId: null });
      }
    }
  } catch (e) {
    mapDriveError(e, userId);
  }
  await repo().logActivity(userId, 'drive_permission_removed', assetId, {});
  return getPermissions(userId, assetId);
}
