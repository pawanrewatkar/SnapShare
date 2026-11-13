import { validateUpload, type MediaAsset, type MediaType } from '@snapshare/shared';

/** Drive requires chunk sizes in multiples of 256 KiB. 8 MiB balances progress granularity and overhead. */
export const CHUNK_SIZE = 32 * 256 * 1024;
const MAX_RETRIES = 5;
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size';

export class DriveError extends Error {
  constructor(
    public code: 'quota' | 'auth' | 'network' | 'not_found' | 'validation' | 'server' | 'aborted',
    message: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

export interface UploadDeps {
  fetch: typeof fetch;
  getToken: (forceRefresh?: boolean) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  loadSession?: () => Promise<string | null>;
  saveSession?: (url: string) => Promise<void>;
  clearSession?: () => Promise<void>;
}

export interface UploadOptions {
  name: string;
  mimeType: string;
  mediaType: MediaType;
  folderId: string;
  captureId: string;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DriveFileResult {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function parseDriveError(res: Response): Promise<DriveError> {
  let reason = '';
  let message = `Google Drive error (${res.status})`;
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    reason = body.error?.errors?.[0]?.reason ?? '';
    if (body.error?.message) message = body.error.message;
  } catch {
    /* ignore */
  }
  if (reason === 'storageQuotaExceeded' || (res.status === 403 && /storage quota/i.test(message)))
    return new DriveError('quota', 'Your Google Drive storage quota is exceeded. Free up space and try again.');
  if (res.status === 401) return new DriveError('auth', 'Google authorization expired.');
  if (res.status === 404) return new DriveError('not_found', 'Upload session not found.');
  return new DriveError('server', message);
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parses "bytes=0-1234" → next offset 1235. */
export function nextOffsetFromRange(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

/**
 * Uploads a blob to Google Drive with the resumable protocol: chunked PUTs, progress reporting,
 * exponential-backoff retries, token refresh on 401 and session resume across interruptions.
 */
export async function resumableUpload(blob: Blob, opts: UploadOptions, deps: UploadDeps): Promise<DriveFileResult> {
  const invalid = validateUpload(opts.mediaType, opts.mimeType, blob.size);
  if (invalid) throw new DriveError('validation', invalid);
  const sleep = deps.sleep ?? defaultSleep;
  const total = blob.size;
  let token = await deps.getToken();

  const authedFetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (opts.signal?.aborted) throw new DriveError('aborted', 'Upload cancelled');
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, signal: opts.signal, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new DriveError('aborted', 'Upload cancelled');
      throw new DriveError('network', 'Network error during upload');
    }
    if (res.status === 401) {
      token = await deps.getToken(true);
      res = await deps.fetch(url, { ...init, signal: opts.signal, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
    }
    return res;
  };

  const createSession = async (): Promise<string> => {
    const res = await authedFetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': opts.mimeType,
        'X-Upload-Content-Length': String(total),
      },
      body: JSON.stringify({
        name: opts.name,
        mimeType: opts.mimeType,
        parents: [opts.folderId],
        appProperties: { snapshare: '1', captureId: opts.captureId, mediaType: opts.mediaType },
      }),
    });
    if (!res.ok) throw await parseDriveError(res);
    const loc = res.headers.get('Location');
    if (!loc) throw new DriveError('server', 'Drive did not return an upload session');
    await deps.saveSession?.(loc);
    return loc;
  };

  /** Asks Drive how many bytes it has; returns either the completed file or the next offset. */
  const queryStatus = async (sessionUrl: string): Promise<{ done?: DriveFileResult; offset: number }> => {
    const res = await authedFetch(sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } });
    if (res.status === 200 || res.status === 201) return { done: toResult(await res.json()), offset: total };
    if (res.status === 308) return { offset: nextOffsetFromRange(res.headers.get('Range')) };
    if (res.status === 404 || res.status === 410) throw new DriveError('not_found', 'Upload session expired');
    throw await parseDriveError(res);
  };

  let sessionUrl = (await deps.loadSession?.()) ?? null;
  let offset = 0;
  if (sessionUrl) {
    try {
      const st = await queryStatus(sessionUrl);
      if (st.done) {
        await deps.clearSession?.();
        return st.done;
      }
      offset = st.offset;
    } catch (e) {
      if (e instanceof DriveError && (e.code === 'quota' || e.code === 'aborted')) throw e;
      sessionUrl = null;
      offset = 0;
    }
  }
  if (!sessionUrl) sessionUrl = await createSession();
  opts.onProgress?.(offset, total);

  let attempt = 0;
  while (true) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    let res: Response | null = null;
    let failure: DriveError | null = null;
    try {
      res = await authedFetch(sessionUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        body: blob.slice(offset, end),
      });
    } catch (e) {
      if (e instanceof DriveError && e.code !== 'network') throw e;
      failure = e as DriveError;
    }
    if (res && (res.status === 200 || res.status === 201)) {
      opts.onProgress?.(total, total);
      await deps.clearSession?.();
      return toResult(await res.json());
    }
    if (res && res.status === 308) {
      offset = nextOffsetFromRange(res.headers.get('Range'));
      attempt = 0;
      opts.onProgress?.(offset, total);
      continue;
    }
    if (res && (res.status === 404 || res.status === 410)) {
      // Session expired: start over with a new one.
      await deps.clearSession?.();
      sessionUrl = await createSession();
      offset = 0;
      continue;
    }
    if (res && !isRetryable(res.status)) throw await parseDriveError(res);
    attempt++;
    if (attempt > MAX_RETRIES) throw failure ?? (res ? await parseDriveError(res) : new DriveError('network', 'Upload failed'));
    await sleep(Math.min(32_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
    try {
      const st = await queryStatus(sessionUrl);
      if (st.done) {
        await deps.clearSession?.();
        return st.done;
      }
      offset = st.offset;
    } catch (e) {
      if (e instanceof DriveError && e.code === 'not_found') {
        sessionUrl = await createSession();
        offset = 0;
      } else if (e instanceof DriveError && e.code !== 'network') throw e;
    }
  }
}

function toResult(json: unknown): DriveFileResult {
  const j = json as { id: string; name: string; mimeType: string; size?: string };
  return { id: j.id, name: j.name, mimeType: j.mimeType, size: Number(j.size ?? 0) };
}

export type { MediaAsset };
