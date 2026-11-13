import { isMediaType } from '@snapshare/shared';
import { requireUser } from '@/lib/auth';
import { handler, json, preflight, readJson } from '@/lib/http';
import { repo } from '@/lib/repo';
import { registerAsset, registerSchema, toPublicAsset } from '@/lib/services/assets';
import { enforceRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

export const GET = handler(async (req) => {
  const { userId } = await requireUser(req);
  const type = req.nextUrl.searchParams.get('type');
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 100);
  const rows = await repo().listAssets(userId, { type: isMediaType(type) ? type : undefined, q: q || undefined });
  return json(rows.map(toPublicAsset));
});

export const POST = handler(async (req) => {
  const { userId } = await requireUser(req);
  await enforceRateLimit(`register:${userId}`, 60, 120);
  const body = registerSchema.parse(await readJson(req));
  return json(toPublicAsset(await registerAsset(userId, body)), 201);
});
