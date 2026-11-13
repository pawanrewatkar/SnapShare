import { publicProfile, requireUser } from '@/lib/auth';
import { handler, json, notFound, preflight } from '@/lib/http';
import { repo } from '@/lib/repo';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const GET = handler(async (req) => {
  const { userId } = await requireUser(req);
  const p = await repo().getProfile(userId);
  if (!p) throw notFound();
  const cred = await repo().getRefreshToken(userId);
  return json({ user: publicProfile(p), driveConnected: !!cred && !cred.revokedAt });
});
