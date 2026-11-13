import { requireUser } from '@/lib/auth';
import { handler, isUuid, noContent, notFound, preflight } from '@/lib/http';
import { revokeShare } from '@/lib/services/shares';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const DELETE = handler<{ id: string }>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  await revokeShare(userId, id);
  return noContent();
});
