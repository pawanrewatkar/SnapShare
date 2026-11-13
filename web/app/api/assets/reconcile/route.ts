import { requireUser } from '@/lib/auth';
import { handler, json, preflight } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';
import { reconcileAssets } from '@/lib/services/assets';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  await enforceRateLimit(`reconcile:${userId}`, 60, 6);
  return json(await reconcileAssets(userId));
});
