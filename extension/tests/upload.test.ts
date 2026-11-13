// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, DriveError, nextOffsetFromRange, resumableUpload, type UploadDeps } from '@/features/drive/upload';

/** Mocked Drive resumable-upload server. Proves client logic only — not real Google Drive behaviour. */
function fakeDrive(opts: { failChunkTimes?: number; quota?: boolean; expireSessionOnce?: boolean; unauthorizedOnce?: boolean } = {}) {
  let received = 0;
  let failures = opts.failChunkTimes ?? 0;
  let expire = !!opts.expireSessionOnce;
  let unauthorized = !!opts.unauthorizedOnce;
  let sessions = 0;
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push(`${init?.method} ${u.includes('uploadType') ? 'create' : 'session'} ${h['Content-Range'] ?? ''}`);
    if (unauthorized && h.Authorization === 'Bearer old') {
      unauthorized = false;
      return new Response('{}', { status: 401 });
    }
    if (u.includes('uploadType=resumable')) {
      if (opts.quota) return new Response(JSON.stringify({ error: { message: 'The user has exceeded their Drive storage quota', errors: [{ reason: 'storageQuotaExceeded' }] } }), { status: 403 });
      sessions++;
      received = 0;
      return new Response(null, { status: 200, headers: { Location: `https://upload.example/session/${sessions}` } });
    }
    const range = h['Content-Range'];
    const total = Number(range.split('/')[1]);
    if (range.startsWith('bytes */')) return received >= total ? new Response(JSON.stringify({ id: 'F1', name: 'n', mimeType: 'image/png', size: String(total) }), { status: 200 }) : new Response(null, { status: 308, headers: received ? { Range: `bytes=0-${received - 1}` } : {} });
    if (expire) {
      expire = false;
      return new Response(null, { status: 404 });
    }
    if (failures > 0) {
      failures--;
      throw new TypeError('Failed to fetch');
    }
    const [start, end] = range.replace('bytes ', '').split('/')[0].split('-').map(Number);
    if (start !== received) return new Response(null, { status: 308, headers: { Range: `bytes=0-${received - 1}` } });
    received = end + 1;
    if (received >= total) return new Response(JSON.stringify({ id: 'F1', name: 'n', mimeType: 'image/png', size: String(total) }), { status: 200 });
    return new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, get sessions() { return sessions; } };
}

const blob = (size: number, type = 'image/png') => new Blob([new Uint8Array(size)], { type });
const opts = { name: 'a.png', mimeType: 'image/png', mediaType: 'screenshot' as const, folderId: 'folder', captureId: 'c1' };
const deps = (f: typeof fetch, extra: Partial<UploadDeps> = {}): UploadDeps => ({ fetch: f, getToken: async () => 'tok', sleep: async () => undefined, ...extra });

describe('resumable Drive upload (mocked Drive API)', () => {
  it('uploads in 256KiB-aligned chunks and reports progress', async () => {
    expect(CHUNK_SIZE % (256 * 1024)).toBe(0);
    const d = fakeDrive();
    const progress: number[] = [];
    const res = await resumableUpload(blob(CHUNK_SIZE * 2 + 10), { ...opts, onProgress: (s) => progress.push(s) }, deps(d.fetch));
    expect(res.id).toBe('F1');
    expect(progress.at(-1)).toBe(CHUNK_SIZE * 2 + 10);
    expect(d.calls.filter((c) => c.startsWith('PUT session bytes ') && !c.includes('*'))).toHaveLength(3);
  });
  it('retries after a network disconnect and resumes from the server offset', async () => {
    const d = fakeDrive({ failChunkTimes: 2 });
    const sleep = vi.fn(async () => undefined);
    const res = await resumableUpload(blob(CHUNK_SIZE + 5), opts, deps(d.fetch, { sleep }));
    expect(res.id).toBe('F1');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(d.calls.some((c) => c.includes('bytes */'))).toBe(true);
  });
  it('gives up with a network error after max retries', async () => {
    const d = fakeDrive({ failChunkTimes: 99 });
    await expect(resumableUpload(blob(100), opts, deps(d.fetch))).rejects.toMatchObject({ code: 'network' });
  });
  it('surfaces Drive storage quota exceeded', async () => {
    const d = fakeDrive({ quota: true });
    const err = await resumableUpload(blob(100), opts, deps(d.fetch)).catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.code).toBe('quota');
  });
  it('refreshes an expired Google token once and continues', async () => {
    const d = fakeDrive({ unauthorizedOnce: true });
    const getToken = vi.fn(async (force?: boolean) => (force ? 'new' : 'old'));
    const res = await resumableUpload(blob(100), opts, { fetch: d.fetch, getToken, sleep: async () => undefined });
    expect(res.id).toBe('F1');
    expect(getToken).toHaveBeenCalledWith(true);
  });
  it('restarts with a new session when the upload session expired', async () => {
    const d = fakeDrive({ expireSessionOnce: true });
    const res = await resumableUpload(blob(100), opts, deps(d.fetch));
    expect(res.id).toBe('F1');
    expect(d.sessions).toBe(2);
  });
  it('resumes a saved session from a previous page instead of starting over', async () => {
    const d = fakeDrive();
    const saved: string[] = [];
    // first attempt: create session, then fail every chunk
    await resumableUpload(blob(CHUNK_SIZE * 2), opts, deps(d.fetch, { saveSession: async (u) => void saved.push(u), loadSession: async () => null })).catch(() => undefined);
    const res = await resumableUpload(blob(CHUNK_SIZE * 2), opts, deps(d.fetch, { loadSession: async () => saved[0] ?? null }));
    expect(res.id).toBe('F1');
  });
  it('rejects invalid uploads before contacting Drive', async () => {
    const d = fakeDrive();
    await expect(resumableUpload(blob(100, 'text/html'), { ...opts, mimeType: 'text/html' }, deps(d.fetch))).rejects.toMatchObject({ code: 'validation' });
    await expect(resumableUpload(blob(0), opts, deps(d.fetch))).rejects.toMatchObject({ code: 'validation' });
    expect(d.calls).toHaveLength(0);
  });
  it('supports cancellation', async () => {
    const d = fakeDrive();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(resumableUpload(blob(100), { ...opts, signal: ctrl.signal }, deps(d.fetch))).rejects.toMatchObject({ code: 'aborted' });
  });
  it('parses Range headers', () => {
    expect(nextOffsetFromRange('bytes=0-1023')).toBe(1024);
    expect(nextOffsetFromRange(null)).toBe(0);
  });
});
