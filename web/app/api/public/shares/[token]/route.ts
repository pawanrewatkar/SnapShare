import { clientIp, handler, json } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveShare, toPublicView } from '@/lib/services/shares';

export const runtime = 'nodejs';

/** Public metadata for a share token. Never returns Drive IDs or owner email. */
export const GET = handler<{ token: string }>(async (req, { token }) => {
  await enforceRateLimit(`share-meta:${clientIp(req)}`, 60, 60);
  const r = await resolveShare(token);
  return json(toPublicView(r), r.status === 'ok' ? 200 : r.status === 'not_found' ? 404 : 410);
});
