import { NextResponse } from 'next/server';
import { allowedExtensionIds } from '@/lib/env';
import { isAllowedExtensionRedirect, signFlowState } from '@/lib/auth';
import { buildGoogleAuthUrl } from '@/lib/google';
import { badRequest, clientIp, handler } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';

export const runtime = 'nodejs';

/** Step 1: extension opens this via chrome.identity.launchWebAuthFlow; we redirect to Google consent. */
export const GET = handler(async (req) => {
  await enforceRateLimit(`auth-start:${clientIp(req)}`, 60, 20);
  const p = req.nextUrl.searchParams;
  const redirectUri = p.get('redirect_uri') ?? '';
  const state = p.get('state') ?? '';
  const challenge = p.get('code_challenge') ?? '';
  if (!isAllowedExtensionRedirect(redirectUri, allowedExtensionIds())) throw badRequest('redirect_uri is not an allowed SnapShare extension');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) throw badRequest('Invalid state');
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw badRequest('Invalid code_challenge');
  const flow = await signFlowState({ extRedirect: redirectUri, extState: state, challenge });
  return NextResponse.redirect(buildGoogleAuthUrl(flow), 302);
});
