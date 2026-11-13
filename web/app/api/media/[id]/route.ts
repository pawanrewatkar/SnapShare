import { env } from '@/lib/env';
import { forbidden, handler, isUuid, notFound } from '@/lib/http';
import { repo } from '@/lib/repo';
import { streamAsset } from '@/lib/services/media';
import { verifyMediaSignature } from '@/lib/signedUrl';

export const runtime = 'nodejs';

export const GET = handler<{ id: string }>(async (req, { id }) => {
  const p = req.nextUrl.searchParams;
  if (!isUuid(id)) throw notFound();
  const userId = p.get('u') ?? '';
  const download = p.get('dl') === '1';
  if (!verifyMediaSignature({ assetId: id, userId, exp: Number(p.get('exp')), download, sig: p.get('sig') ?? '' }, env().SESSION_SECRET)) throw forbidden('Link expired');
  const asset = await repo().getAsset(id);
  if (!asset || asset.userId !== userId) throw notFound();
  return streamAsset(asset, { range: req.headers.get('range'), download });
});
