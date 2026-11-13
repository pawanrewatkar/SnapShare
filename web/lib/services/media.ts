import type { AssetRow } from '../repo/types';
import { driveFor, mapDriveError } from '../driveAccess';
import { repo } from '../repo';
import { DriveApiError } from '../drive';
import { HttpError } from '../http';

function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const RANGE = /^bytes=\d*-\d*$/;

/**
 * Streams a Drive file through the backend with HTTP Range support (video seeking).
 * Content-Type comes from our validated metadata, never from Drive, and the response is sandboxed.
 */
export async function streamAsset(asset: AssetRow, opts: { range: string | null; download: boolean }): Promise<Response> {
  const drive = await driveFor(asset.userId);
  let upstream: Response;
  try {
    upstream = await drive.download(asset.driveFileId, opts.range && RANGE.test(opts.range) ? opts.range : null);
  } catch (e) {
    if (e instanceof DriveApiError && e.isNotFound) await repo().updateAsset(asset.id, { status: 'missing' });
    if (e instanceof DriveApiError && e.status === 416) throw new HttpError(416, 'validation', 'Requested range not satisfiable');
    mapDriveError(e, asset.userId);
  }
  const headers = new Headers({
    'Content-Type': asset.mimeType,
    'Content-Disposition': contentDisposition(opts.download ? 'attachment' : 'inline', asset.filename),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  for (const h of ['Content-Length', 'Content-Range']) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}

export async function thumbnailResponse(asset: AssetRow): Promise<Response> {
  const drive = await driveFor(asset.userId);
  try {
    const thumb = await drive.thumbnail(asset.driveFileId);
    if (thumb) {
      return new Response(thumb.body, { headers: { 'Content-Type': thumb.headers.get('Content-Type') ?? 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    }
  } catch (e) {
    if (e instanceof DriveApiError && e.isNotFound) await repo().updateAsset(asset.id, { status: 'missing' });
    mapDriveError(e, asset.userId);
  }
  // Drive generates thumbnails asynchronously; fall back to the image itself (bounded size).
  if (asset.mediaType !== 'video' && asset.size <= 15 * 1024 * 1024) return streamAsset(asset, { range: null, download: false });
  return new Response(null, { status: 204 });
}
