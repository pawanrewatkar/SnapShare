import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { handler, isUuid, json, notFound, preflight } from '@/lib/http';
import { getOwnedAsset } from '@/lib/services/assets';
import { signMedia } from '@/lib/signedUrl';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

/** Issues a 10-minute signed URL for the owner's own media (preview/download in the extension). */
export const POST = handler<{ id: string }>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  const asset = await getOwnedAsset(userId, id);
  const download = req.nextUrl.searchParams.get('download') === '1';
  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = signMedia(asset.id, userId, exp, download, env().SESSION_SECRET);
  const u = new URL(`${env().APP_BASE_URL}/api/media/${asset.id}`);
  u.searchParams.set('u', userId);
  u.searchParams.set('exp', String(exp));
  u.searchParams.set('sig', sig);
  if (download) u.searchParams.set('dl', '1');
  return json({ url: u.toString(), expiresAt: new Date(exp * 1000).toISOString() });
});
