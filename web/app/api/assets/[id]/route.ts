import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { handler, isUuid, json, noContent, notFound, preflight, readJson } from '@/lib/http';
import { deleteAssetFully, getOwnedAsset, renameAsset, toPublicAsset } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const OPTIONS = preflight;
type P = { id: string };

export const GET = handler<P>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  return json(toPublicAsset(await getOwnedAsset(userId, id)));
});

export const PATCH = handler<P>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  const { filename } = z.object({ filename: z.string().trim().min(1).max(200) }).parse(await readJson(req));
  return json(toPublicAsset(await renameAsset(userId, id, filename)));
});

export const DELETE = handler<P>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  await deleteAssetFully(userId, id);
  return noContent();
});
