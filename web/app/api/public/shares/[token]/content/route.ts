import { clientIp, forbidden, handler, HttpError } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';
import { repo } from '@/lib/repo';
import { streamAsset } from '@/lib/services/media';
import { resolveShare } from '@/lib/services/shares';

export const runtime = 'nodejs';

/** Streams shared media after validating token, revocation and expiry. The owner's Google token never leaves the server. */
export const GET = handler<{ token: string }>(async (req, { token }) => {
  await enforceRateLimit(`share-content:${clientIp(req)}`, 60, 300);
  const r = await resolveShare(token);
  if (r.status !== 'ok' || !r.asset || !r.share) throw new HttpError(r.status === 'not_found' ? 404 : 410, 'not_found', `Link ${r.status.replace('_', ' ')}`);
  const download = req.nextUrl.searchParams.get('download') === '1';
  if (download && !r.share.allowDownload) throw forbidden('The owner disabled downloads for this link');
  const range = req.headers.get('range');
  if (!range || range.startsWith('bytes=0-')) await repo().incrementShareView(r.share.id).catch(() => undefined);
  return streamAsset(r.asset, { range, download });
});
