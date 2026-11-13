import { requireUser } from '@/lib/auth';
import { handler, isUuid, json, notFound, preflight } from '@/lib/http';
import { removePermission } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const DELETE = handler<{ id: string; permissionId: string }>(async (req, { id, permissionId }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  return json(await removePermission(userId, id, permissionId));
});
