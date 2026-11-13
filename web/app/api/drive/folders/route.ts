import { requireUser } from '@/lib/auth';
import { handler, json, preflight } from '@/lib/http';
import { ensureFolders } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  return json({ userId, folders: await ensureFolders(userId) });
});
