import { requireUser } from '@/lib/auth';
import { handler, isUuid, json, notFound, preflight, readJson } from '@/lib/http';
import { addPermission, addPermissionSchema, getPermissions } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const OPTIONS = preflight;
type P = { id: string };

export const GET = handler<P>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  return json(await getPermissions(userId, id));
});

export const POST = handler<P>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  return json(await addPermission(userId, id, addPermissionSchema.parse(await readJson(req))));
});
