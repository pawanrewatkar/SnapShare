import { hmac, safeEqual } from './crypto';

/** Short-lived HMAC-signed media URLs so <img>/<video> can stream owner content without bearer headers. */
export function signMedia(assetId: string, userId: string, expiresAtSec: number, download: boolean, secret: string): string {
  return hmac(`media:${assetId}:${userId}:${expiresAtSec}:${download ? 1 : 0}`, secret);
}

export function verifyMediaSignature(p: { assetId: string; userId: string; exp: number; download: boolean; sig: string }, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isFinite(p.exp) || p.exp < nowSec) return false;
  return safeEqual(signMedia(p.assetId, p.userId, p.exp, p.download, secret), p.sig);
}
