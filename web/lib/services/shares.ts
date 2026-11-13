import { z } from 'zod';
import type { PublicShareView, ShareLink } from '@snapshare/shared';
import { decrypt, encrypt, randomToken, sha256Hex } from '../crypto';
import { env } from '../env';
import { repo } from '../repo';
import type { AssetRow, Profile, ShareRow } from '../repo/types';
import { driveFor, mapDriveError } from '../driveAccess';
import { badRequest, notFound } from '../http';
import { getOwnedAsset } from './assets';

export const createShareSchema = z.object({
  accessType: z.enum(['public', 'restricted']),
  expiresInDays: z.number().int().min(1).max(365).nullable(),
  allowDownload: z.boolean(),
});

/** 32 random bytes → 43 base64url chars. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function shareUrl(token: string): string {
  return `${env().APP_BASE_URL}/s/${token}`;
}

export function toShareLink(s: ShareRow, includeUrl: boolean): ShareLink {
  let url: string | undefined;
  if (includeUrl && s.isActive) {
    try {
      url = shareUrl(decrypt(s.tokenCiphertext, env().ENCRYPTION_KEY));
    } catch {
      url = undefined;
    }
  }
  return {
    id: s.id,
    assetId: s.assetId,
    accessType: s.accessType,
    allowDownload: s.allowDownload,
    expiresAt: s.expiresAt,
    isActive: s.isActive && (!s.expiresAt || new Date(s.expiresAt) > new Date()),
    createdAt: s.createdAt,
    revokedAt: s.revokedAt,
    url,
  };
}

export async function listSharesForOwner(userId: string, assetId: string): Promise<ShareLink[]> {
  await getOwnedAsset(userId, assetId);
  return (await repo().listShares(assetId)).map((s) => toShareLink(s, true));
}

/**
 * Creates a share link. Only the hash (lookup) and an AES-GCM ciphertext (so the owner can copy it again)
 * are stored. Public links additionally grant Drive "anyone with link" reader access — explicit user choice only.
 */
export async function createShare(userId: string, assetId: string, input: z.infer<typeof createShareSchema>, now = new Date()): Promise<ShareLink> {
  const asset = await getOwnedAsset(userId, assetId);
  if (asset.status === 'missing') throw badRequest('This file no longer exists in Google Drive');
  const token = randomToken(32);
  let drivePermissionId: string | null = null;
  if (input.accessType === 'public') {
    try {
      const drive = await driveFor(userId);
      const existing = (await drive.listPermissions(asset.driveFileId)).find((p) => p.type === 'anyone');
      if (!existing) drivePermissionId = (await drive.createPermission(asset.driveFileId, { type: 'anyone' })).id;
    } catch (e) {
      mapDriveError(e, userId);
    }
    await repo().updateAsset(assetId, { isDrivePublic: true });
  }
  const row = await repo().insertShare({
    assetId,
    userId,
    tokenHash: sha256Hex(token),
    tokenCiphertext: encrypt(token, env().ENCRYPTION_KEY),
    accessType: input.accessType,
    allowDownload: input.allowDownload,
    expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString() : null,
    drivePermissionId,
  });
  await repo().logActivity(userId, 'share_create', assetId, { accessType: input.accessType, expiresInDays: input.expiresInDays });
  return { ...toShareLink(row, false), url: shareUrl(token) };
}

/** Removes the Drive "anyone" permission a public share created, unless another active public share still needs it. */
async function releasePublicPermission(share: ShareRow, asset: AssetRow | null): Promise<void> {
  if (share.accessType !== 'public' || !share.drivePermissionId || !asset) return;
  const others = (await repo().listShares(share.assetId)).filter((s) => s.id !== share.id && s.isActive && s.accessType === 'public' && (!s.expiresAt || new Date(s.expiresAt) > new Date()));
  if (others.length > 0) {
    await repo().updateShare(others[0].id, { drivePermissionId: share.drivePermissionId });
    return;
  }
  try {
    await (await driveFor(share.userId)).deletePermission(asset.driveFileId, share.drivePermissionId);
  } catch (e) {
    mapDriveError(e, share.userId);
  }
  await repo().updateAsset(asset.id, { isDrivePublic: false });
}

export async function revokeShare(userId: string, shareId: string): Promise<void> {
  const share = await repo().getShare(shareId);
  if (!share || share.userId !== userId) throw notFound('Share link not found');
  if (share.revokedAt) return;
  await repo().updateShare(shareId, { isActive: false, revokedAt: new Date().toISOString() });
  await releasePublicPermission(share, await repo().getAsset(share.assetId));
  await repo().updateShare(shareId, { drivePermissionId: null });
  await repo().logActivity(userId, 'share_revoke', share.assetId, {});
}

export type ResolveStatus = PublicShareView['status'];

export interface ResolvedShare {
  status: ResolveStatus;
  share?: ShareRow;
  asset?: AssetRow;
  owner?: Profile | null;
}

/** Validates a public share token: format → hash lookup → revoked → expired → asset exists. */
export async function resolveShare(token: string, now = new Date()): Promise<ResolvedShare> {
  if (!TOKEN_PATTERN.test(token)) return { status: 'not_found' };
  const share = await repo().getShareByHash(sha256Hex(token));
  if (!share) return { status: 'not_found' };
  if (share.revokedAt) return { status: 'revoked', share };
  if (share.expiresAt && new Date(share.expiresAt) <= now) return { status: 'expired', share };
  if (!share.isActive) return { status: 'revoked', share };
  const asset = await repo().getAsset(share.assetId);
  if (!asset || asset.userId !== share.userId) return { status: 'not_found' };
  if (asset.status === 'missing') return { status: 'missing', share, asset };
  return { status: 'ok', share, asset, owner: await repo().getProfile(share.userId) };
}

export function toPublicView(r: ResolvedShare): PublicShareView {
  if (r.status !== 'ok' || !r.share || !r.asset) return { status: r.status, expiresAt: r.share?.expiresAt ?? null };
  return {
    status: 'ok',
    filename: r.asset.filename,
    mediaType: r.asset.mediaType,
    mimeType: r.asset.mimeType,
    size: r.asset.size,
    width: r.asset.width,
    height: r.asset.height,
    durationMs: r.asset.durationMs,
    createdAt: r.asset.createdAt,
    expiresAt: r.share.expiresAt,
    allowDownload: r.share.allowDownload,
    accessType: r.share.accessType,
    ownerName: r.owner?.name ?? null,
  };
}

/** Cron: deactivate expired links and withdraw Drive public access they granted. */
export async function expireShares(now = new Date()): Promise<{ expired: number }> {
  const rows = await repo().listExpiredActiveShares(now, 200);
  for (const s of rows) {
    await repo().updateShare(s.id, { isActive: false });
    try {
      await releasePublicPermission(s, await repo().getAsset(s.assetId));
      await repo().updateShare(s.id, { drivePermissionId: null });
    } catch (e) {
      console.error('[cron] could not release permission for share', s.id, (e as Error).message);
    }
  }
  return { expired: rows.length };
}
