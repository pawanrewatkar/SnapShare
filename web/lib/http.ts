import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import type { ApiErrorCode } from '@snapshare/shared';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, 'validation', m);
export const unauthorized = (m = 'Sign in required') => new HttpError(401, 'unauthenticated', m);
export const reauth = (m = 'Google authorization expired or was revoked. Please sign in again.') => new HttpError(401, 'reauth_required', m);
export const forbidden = (m = 'Not allowed') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
export const tooMany = (m = 'Too many requests, slow down.') => new HttpError(429, 'rate_limited', m);

/** Extension origins allowed to call the API cross-origin. */
function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const ids = (process.env.ALLOWED_EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.some((id) => origin === `chrome-extension://${id}`)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }
  return { Vary: 'Origin' };
}

export function errorResponse(e: unknown, req?: NextRequest): NextResponse {
  let status = 500;
  let code: ApiErrorCode = 'server_error';
  let message = 'Something went wrong. Please try again.';
  if (e instanceof HttpError) {
    status = e.status;
    code = e.code;
    message = e.message;
  } else if (e instanceof ZodError) {
    status = 400;
    code = 'validation';
    message = e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  } else {
    // Log server-side only; never leak internals (tokens, stack traces) to clients.
    console.error('[api] unhandled error', e instanceof Error ? e.message : e);
  }
  return NextResponse.json({ error: { code, message } }, { status, headers: req ? corsHeaders(req) : undefined });
}

type Ctx<P> = { params: Promise<P> };

/** Wraps a route handler with JSON error mapping and CORS headers. */
export function handler<P = Record<string, string>>(fn: (req: NextRequest, params: P) => Promise<Response>) {
  return async (req: NextRequest, ctx: Ctx<P>): Promise<Response> => {
    try {
      const params = ctx?.params ? await ctx.params : ({} as P);
      const res = await fn(req, params);
      for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
      return res;
    } catch (e) {
      return errorResponse(e, req);
    }
  };
}

export function preflight(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const noContent = () => new NextResponse(null, { status: 204 });

export async function readJson(req: NextRequest, maxBytes = 64 * 1024): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw badRequest('Request body too large');
  const text = await req.text();
  if (text.length > maxBytes) throw badRequest('Request body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Invalid JSON');
  }
}

export function clientIp(req: { headers: Headers }): string {
  return req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
