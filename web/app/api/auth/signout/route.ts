import { requireUser } from '@/lib/auth';
import { handler, noContent, preflight } from '@/lib/http';
import { repo } from '@/lib/repo';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const POST = handler(async (req) => {
  const { sessionId, userId } = await requireUser(req);
  await repo().revokeSession(sessionId);
  await repo().logActivity(userId, 'sign_out', null, {});
  return noContent();
});
