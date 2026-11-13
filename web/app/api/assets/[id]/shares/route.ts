import { requireUser } from '@/lib/auth';
import { handler, isUuid, json, notFound, preflight, readJson } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createShare, createShareSchema, listSharesForOwner } from '@/lib/services/shares';

export const runtime = 'nodejs';
export const OPTIONS = preflight;
type P = { id: string };

export const GET = handler<P>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  return json(await listSharesForOwner(userId, id));
});

export const POST = handler<P>(async (req, { id }) => {
  const { userId } = await requireUser(req);
  if (!isUuid(id)) throw notFound();
  await enforceRateLimit(`share-create:${userId}`, 60, 30);
  return json(await createShare(userId, id, createShareSchema.parse(await readJson(req))), 201);
});
