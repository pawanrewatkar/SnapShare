import { NextResponse } from 'next/server';
import { encrypt, randomToken, sha256Hex } from '@/lib/crypto';
import { allowedExtensionIds, env } from '@/lib/env';
import { isAllowedExtensionRedirect, verifyFlowState } from '@/lib/auth';
import { DRIVE_FILE_SCOPE, exchangeCode, hasScope, verifyIdToken } from '@/lib/google';
import { badRequest, handler } from '@/lib/http';
import { repo } from '@/lib/repo';

export const runtime = 'nodejs';

/** Step 2: Google redirects here. Exchange the code server-side (client secret never leaves the server). */
export const GET = handler(async (req) => {
  const p = req.nextUrl.searchParams;
  let flow;
  try {
    flow = await verifyFlowState(p.get('state') ?? '');
  } catch {
    throw badRequest('Sign-in session expired. Please start again from the extension.');
  }
  if (!isAllowedExtensionRedirect(flow.extRedirect, allowedExtensionIds())) throw badRequest('Invalid redirect');
  const back = (params: Record<string, string>) => {
    const u = new URL(flow.extRedirect);
    for (const [k, v] of Object.entries({ ...params, state: flow.extState })) u.searchParams.set(k, v);
    return NextResponse.redirect(u.toString(), 302);
  };
  const googleError = p.get('error');
  if (googleError) return back({ error: googleError === 'access_denied' ? 'access_denied' : 'google_error' });
  const code = p.get('code');
  if (!code) return back({ error: 'missing_code' });

  const tokens = await exchangeCode(code).catch(() => null);
  if (!tokens?.id_token) return back({ error: 'token_exchange_failed' });
  if (!hasScope(tokens.scope, DRIVE_FILE_SCOPE)) return back({ error: 'drive_permission_required' });
  const identity = await verifyIdToken(tokens.id_token).catch(() => null);
  if (!identity || !identity.emailVerified) return back({ error: 'unverified_account' });

  const profile = await repo().upsertUserFromGoogle({ sub: identity.sub, email: identity.email, name: identity.name, picture: identity.picture, scopes: tokens.scope.split(' ') });
  if (tokens.refresh_token) await repo().saveRefreshToken(profile.id, encrypt(tokens.refresh_token, env().ENCRYPTION_KEY));
  else if (!(await repo().getRefreshToken(profile.id))) return back({ error: 'offline_access_required' });

  const oneTime = randomToken(32);
  await repo().createAuthCode({ codeHash: sha256Hex(oneTime), userId: profile.id, codeChallenge: flow.challenge, redirectUri: flow.extRedirect, expiresAt: new Date(Date.now() + 2 * 60_000).toISOString() });
  await repo().logActivity(profile.id, 'sign_in', null, {});
  return back({ code: oneTime });
});
