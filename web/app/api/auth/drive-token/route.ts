import { requireUser } from '@/lib/auth';
import { getUserAccessToken } from '@/lib/driveAccess';
import { handler, json, preflight } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

/** Short-lived Drive access token for the signed-in owner only (used for direct resumable uploads). */
export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  await enforceRateLimit(`drive-token:${userId}`, 60, 60);
  const t = await getUserAccessToken(userId);
  return json({ accessToken: t.token, expiresAt: t.expiresAt });
});
