import { env } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { handler, json, unauthorized } from '@/lib/http';
import { expireShares } from '@/lib/services/shares';

export const runtime = 'nodejs';

/** Vercel Cron: deactivates expired links and removes Drive public access they had granted. */
export const GET = handler(async (req) => {
  const secret = env().CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)) throw unauthorized();
  return json(await expireShares());
});
