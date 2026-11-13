import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { formatBytes, formatDuration, type PublicShareView } from '@snapshare/shared';
import { clientIp, HttpError } from '@/lib/http';
import { enforceRateLimit } from '@/lib/rateLimit';
import { resolveShare, toPublicView } from '@/lib/services/shares';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = { title: 'Shared file', robots: { index: false, follow: false }, referrer: 'no-referrer' };

const MESSAGES: Record<Exclude<PublicShareView['status'], 'ok'>, { title: string; body: string }> = {
  expired: { title: 'This link has expired', body: 'The owner set this link to expire. Ask them for a new link.' },
  revoked: { title: 'This link was revoked', body: 'The owner turned off access to this file.' },
  not_found: { title: 'Link not found', body: 'Check that you copied the whole link.' },
  missing: { title: 'File no longer available', body: 'The owner deleted this file from their Google Drive.' },
};

function StatusCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-slate-600 dark:text-slate-400">{body}</p>
    </div>
  );
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  try {
    await enforceRateLimit(`share-page:${clientIp({ headers: h })}`, 60, 60);
  } catch (e) {
    if (e instanceof HttpError) return <StatusCard title="Too many requests" body="Please wait a minute and reload." />;
    throw e;
  }
  const view = toPublicView(await resolveShare(token));
  if (view.status !== 'ok') return <StatusCard {...MESSAGES[view.status]} />;

  const src = `/api/public/shares/${encodeURIComponent(token)}/content`;
  const isVideo = view.mediaType === 'video';
  const typeLabel = view.mediaType === 'video' ? 'Screen recording' : view.mediaType === 'edited' ? 'Edited screenshot' : 'Screenshot';
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-center bg-slate-100 dark:bg-slate-950">
          {isVideo ? (
            <video src={src} controls preload="metadata" className="max-h-[75vh] w-full bg-black" />
          ) : (
            
            <img src={src} alt={view.filename} className="max-h-[75vh] w-auto max-w-full object-contain" />
          )}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold" title={view.filename}>
              {view.filename}
            </h1>
            <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
              <div>
                <dt className="sr-only">Type</dt>
                <dd>
                  {typeLabel} · {view.mimeType}
                </dd>
              </div>
              <div>
                <dt className="sr-only">Size</dt>
                <dd>{formatBytes(view.size ?? 0)}</dd>
              </div>
              {view.width && view.height ? (
                <div>
                  <dt className="sr-only">Dimensions</dt>
                  <dd>
                    {view.width} × {view.height}px
                  </dd>
                </div>
              ) : null}
              {view.durationMs ? (
                <div>
                  <dt className="sr-only">Duration</dt>
                  <dd>{formatDuration(view.durationMs)}</dd>
                </div>
              ) : null}
              {view.createdAt && (
                <div>
                  <dt className="sr-only">Created</dt>
                  <dd>Created {new Date(view.createdAt).toUTCString()}</dd>
                </div>
              )}
              {view.expiresAt && (
                <div>
                  <dt className="sr-only">Expires</dt>
                  <dd>Link expires {new Date(view.expiresAt).toUTCString()}</dd>
                </div>
              )}
            </dl>
            {view.ownerName && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Shared by {view.ownerName}</p>}
          </div>
          {view.allowDownload ? (
            <a href={`${src}?download=1`} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Download
            </a>
          ) : (
            <span className="text-xs text-slate-500">Download disabled by the owner</span>
          )}
        </div>
      </div>
    </div>
  );
}
