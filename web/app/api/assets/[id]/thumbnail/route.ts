import { requireUser } from '@/lib/auth';
import { handler, isUuid, notFound, preflight } from '@/lib/http';
import { getOwnedAsset } from '@/lib/services/assets';
import { thumbnailResponse } from '@/lib/services/media';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const GET = handler<{ id: string }>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  return thumbnailResponse(await getOwnedAsset(userId, id));
});
