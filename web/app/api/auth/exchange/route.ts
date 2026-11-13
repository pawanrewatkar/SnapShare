import { z } from 'zod';
import { sha256Hex, verifyPkce } from '@/lib/crypto';
import { issueSession, publicProfile } from '@/lib/auth';
import { clientIp, handler, json, preflight, readJson, unauthorized } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';
import { repo } from '@/lib/repo';

export const runtime = 'nodejs';
export const OPTIONS = preflight;

const schema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_verifier: z.string().min(43).max(128), redirect_uri: z.string().url() });

/** Step 3: extension trades the one-time code + PKCE verifier for a SnapShare session. */
export const POST = handler(async (req) => {
  await enforceRateLimit(`auth-exchange:${clientIp(req)}`, 60, 20);
  const body = schema.parse(await readJson(req));
  const row = await repo().consumeAuthCode(sha256Hex(body.code), new Date());
  if (!row || row.redirectUri !== body.redirect_uri || !verifyPkce(body.code_verifier, row.codeChallenge)) throw unauthorized('Invalid or expired sign-in code');
  const profile = await repo().getProfile(row.userId);
  if (!profile) throw unauthorized();
  const session = await issueSession(profile.id, req.headers.get('user-agent'));
  return json({ ...session, user: publicProfile(profile) });
});
