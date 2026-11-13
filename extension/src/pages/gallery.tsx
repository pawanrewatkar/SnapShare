import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, formatDuration } from '@snapshare/shared';
import { mount } from './mount';
import { Button, EmptyState, Logo, Modal, ProgressBar, Spinner, useToast } from '@/components/ui';
import * as I from '@/components/icons';
import { friendlyError } from '@/services/api';
import { deleteCapture, getCapture, listCaptures, updateCapture, type CaptureMeta } from '@/services/db';
import { copyImageToClipboard, downloadBlob } from '@/services/media';
import { platform } from '@/browser';
import { useSession } from '@/hooks';
import { useUpload } from '@/features/drive/useUpload';
import { ShareDialog, copyDriveFileLink } from '@/features/sharing/ShareDialog';
import { listDriveFiles, mergeItems, type Category, type GalleryItem } from '@/features/gallery/galleryApi';
import { drive, type DriveFile } from '@/features/drive/driveApi';
import { getAccessToken } from '@/features/authentication/auth';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'screenshot', label: 'Screenshots' },
  { id: 'edited', label: 'Edited Images' },
  { id: 'video', label: 'Videos' },
];

/** Lazily loads a thumbnail when the card scrolls into view; revokes object URLs on unmount. */
function Thumbnail({ item }: { item: GalleryItem }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (item.mediaType === 'video') return;
    const el = ref.current;
    if (!el) return;
    let created: string | null = null;
    let cancelled = false;
    const ctrl = new AbortController();
    const obs = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting) return;
      obs.disconnect();
      try {
        if (item.source === 'local') {
          const rec = await getCapture(item.id);
          if (rec && !cancelled) created = URL.createObjectURL(rec.blob);
        } else {
          // Drive thumbnails are generated asynchronously; fall back to the (bounded) image itself.
          const blob = (await drive.thumbnailBlob(item.file!)) ?? (item.size <= 15 * 1024 * 1024 ? await drive.downloadBlob(item.id) : null);
          if (blob && !cancelled) created = URL.createObjectURL(blob);
        }
        if (!cancelled) setUrl(created);
      } catch {
        if (!cancelled) setFailed(true);
      }
    });
    obs.observe(el);
    return () => {
      cancelled = true;
      ctrl.abort();
      obs.disconnect();
      if (created) URL.revokeObjectURL(created);
    };
  }, [item.id, item.source, item.mediaType, item.status, item.file, item.size]);
  return (
    <div ref={ref} className="flex aspect-video items-center justify-center overflow-hidden bg-slate-100 dark:bg-slate-800">
      {item.mediaType === 'video' ? (
        <I.IconVideo width={32} height={32} className="text-slate-400" />
      ) : url ? (
        <img src={url} alt="" className="h-full w-full object-cover object-top" />
      ) : failed ? (
        <span className="text-xs text-slate-400">No preview</span>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

function PreviewModal({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let created: string | null = null;
    (async () => {
      if (item.source === 'local') {
        const rec = await getCapture(item.id);
        if (!rec) throw new Error('Not found on this device');
        created = URL.createObjectURL(rec.blob);
        setSrc(created);
      } else {
        created = URL.createObjectURL(await drive.downloadBlob(item.id));
        setSrc(created);
      }
    })().catch((e) => setErr(friendlyError(e)));
    return () => {
      if (created) URL.revokeObjectURL(created);
    };
  }, [item]);
  return (
    <Modal open title={item.filename} onClose={onClose} wide>
      {err ? <p className="text-red-600">{err}</p> : !src ? <Spinner /> : item.mediaType === 'video' ? <video src={src} controls autoPlay className="max-h-[70vh] w-full bg-black" /> : <img src={src} alt={item.filename} className="max-h-[70vh] w-full object-contain" />}
    </Modal>
  );
}

function Gallery() {
  const toast = useToast();
  const { session, loading: sessionLoading } = useSession();
  const [category, setCategory] = useState<Category>('all');
  const [source, setSource] = useState<'all' | 'cloud' | 'local'>('all');
  const [q, setQ] = useState('');
  const [assets, setAssets] = useState<DriveFile[]>([]);
  const [local, setLocal] = useState<CaptureMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [rename, setRename] = useState<{ item: GalleryItem; value: string } | null>(null);
  const [share, setShare] = useState<{ id: string; filename: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { upload, uploading, progress } = useUpload();
  const highlight = new URLSearchParams(location.search).get('highlight');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLocal(await listCaptures());
      if (session) setAssets(await listDriveFiles());
      else setAssets([]);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (!sessionLoading) void load();
  }, [load, sessionLoading]);

  // Drive is listed live on every load, so files deleted in Drive show up as "missing" automatically.
  const sync = async () => {
    setSyncing(true);
    await load();
    setSyncing(false);
  };

  const items = mergeItems(assets, local, category, q, source, session?.user.id ?? null);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast('error', friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const download = (item: GalleryItem) =>
    act(`dl-${item.key}`, async () => {
      if (item.source === 'local') {
        const rec = await getCapture(item.id);
        if (!rec) throw new Error('Not found on this device');
        await downloadBlob(rec.blob, rec.filename);
      } else {
        // chrome.downloads streams straight from Drive with the bearer header (no full copy in memory).
        await platform.download(drive.mediaUrl(item.id), item.filename, false, [{ name: 'Authorization', value: `Bearer ${await getAccessToken(false)}` }]);
      }
      toast('success', 'Download started');
    });

  const copyImage = (item: GalleryItem) =>
    act(`cp-${item.key}`, async () => {
      let blob: Blob;
      if (item.source === 'local') blob = (await getCapture(item.id))!.blob;
      else {
        blob = await drive.downloadBlob(item.id);
      }
      await copyImageToClipboard(blob);
      toast('success', 'Image copied to clipboard');
    });

  const remove = (item: GalleryItem) =>
    act(`rm-${item.key}`, async () => {
      if (item.status === 'missing') {
        // Deleted in Drive: keep the local copy, forget the dead Drive link so it can be re-uploaded.
        await updateCapture(item.id, { cloud: null });
      } else if (item.source === 'local') {
        if (!confirm(`Delete “${item.filename}” from this device?`)) return;
        await deleteCapture(item.id);
      } else {
        if (!confirm(`Permanently delete “${item.filename}” from your Google Drive? Anyone it was shared with loses access.`)) return;
        await drive.delete(item.id);
        // Unlink any local copy so it can be re-uploaded later.
        const linked = local.find((l) => l.cloud?.driveFileId === item.id);
        if (linked) await updateCapture(linked.id, { cloud: null });
      }
      toast('success', 'Deleted');
      await load();
    });

  const copyLink = (item: GalleryItem) =>
    act(`ln-${item.key}`, async () => {
      await copyDriveFileLink(item.id);
      toast('success', 'Drive link copied. Use Share to give people access — the file stays private until you do.');
    });

  const uploadLocal = (item: GalleryItem) =>
    act(`up-${item.key}`, async () => {
      if (!session) throw new Error('Sign in with Google first.');
      if (await upload(item.id)) await load();
    });

  const submitRename = () =>
    rename &&
    act('rename', async () => {
      const name = rename.value.trim();
      if (!name) throw new Error('Name cannot be empty');
      if (rename.item.source === 'cloud') {
        const ext = rename.item.mimeType === 'video/webm' ? '.webm' : rename.item.mimeType === 'image/jpeg' ? '.jpg' : '.png';
        await drive.rename(rename.item.id, name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`);
      } else await updateCapture(rename.item.id, { filename: name });
      setRename(null);
      toast('success', 'Renamed');
      await load();
    });

  return (
    <div className="mx-auto max-w-7xl p-6">
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <Logo />
        <h1 className="text-lg font-semibold text-slate-500">Gallery</h1>
        <div className="ml-auto flex items-center gap-2">
          {session ? (
            <Button size="sm" loading={syncing} onClick={() => void sync()} title="Reload the file list from Google Drive">
              Refresh from Drive
            </Button>
          ) : (
            <span className="text-xs text-slate-500">Sign in from the popup or Settings to see your Google Drive files.</span>
          )}
          <a href="settings.html" className="text-sm text-brand-600 hover:underline">
            Settings
          </a>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <nav className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800" aria-label="Categories">
          {CATEGORIES.map((c) => (
            <button key={c.id} aria-pressed={category === c.id} onClick={() => setCategory(c.id)} className={`rounded-md px-3 py-1.5 text-sm ${category === c.id ? 'bg-white font-medium shadow dark:bg-slate-700' : 'text-slate-600 dark:text-slate-300'}`}>
              {c.label}
            </button>
          ))}
        </nav>
        <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as typeof source)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900">
          <option value="all">Drive + this device</option>
          <option value="cloud">Google Drive only</option>
          <option value="local">Not uploaded (this device)</option>
        </select>
        <input type="search" placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-[200px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900" />
      </div>
      {uploading && (
        <div className="mb-4">
          <ProgressBar value={progress} />
        </div>
      )}

      {error && <p className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading ? (
        <div className="flex justify-center p-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={q ? 'No files match your search.' : 'No captures yet.'}>Use the SnapShare toolbar button to take a screenshot or record your screen.</EmptyState>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <li key={item.key} className={`overflow-hidden rounded-xl border bg-white shadow-sm dark:bg-slate-900 ${highlight === item.id ? 'border-brand-500 ring-2 ring-brand-500' : 'border-slate-200 dark:border-slate-800'}`}>
              <button className="block w-full" onClick={() => setPreview(item)} aria-label={`Preview ${item.filename}`}>
                <Thumbnail item={item} />
              </button>
              <div className="p-3">
                <p className="truncate text-sm font-medium" title={item.filename}>
                  {item.filename}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-slate-500">
                  <span>{item.mediaType === 'screenshot' ? 'Screenshot' : item.mediaType === 'edited' ? 'Edited image' : 'Video'}</span>
                  <span>{item.mimeType.split('/')[1]?.toUpperCase()}</span>
                  <span>{formatBytes(item.size)}</span>
                  {item.durationMs ? <span>{formatDuration(item.durationMs)}</span> : null}
                  <span>{new Date(item.createdAt).toLocaleString()}</span>
                </p>
                <p className="mt-1 text-[11px]">
                  {item.status === 'missing' ? (
                    <span className="text-red-600">Deleted from Google Drive · local copy kept</span>
                  ) : item.source === 'cloud' ? (
                    <span className="text-emerald-600">In your Google Drive (open Share to see who has access)</span>
                  ) : (
                    <span className="text-slate-500">Only on this device</span>
                  )}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.status === 'missing' ? (
                    <Button size="sm" loading={busy === `rm-${item.key}`} onClick={() => void remove(item)}>
                      Unlink (re-upload later)
                    </Button>
                  ) : (
                    <>
                      {item.source === 'local' && item.mediaType !== 'video' && (
                        <Button size="sm" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${item.id}`) })}>
                          <I.IconEdit /> Edit
                        </Button>
                      )}
                      <Button size="sm" loading={busy === `dl-${item.key}`} onClick={() => void download(item)}>
                        <I.IconDownload />
                      </Button>
                      {item.mediaType !== 'video' && (
                        <Button size="sm" loading={busy === `cp-${item.key}`} onClick={() => void copyImage(item)} title="Copy image">
                          <I.IconCopy />
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setRename({ item, value: item.filename })} title="Rename">
                        Rename
                      </Button>
                      {item.source === 'cloud' ? (
                        <>
                          <Button size="sm" loading={busy === `ln-${item.key}`} onClick={() => void copyLink(item)} title="Copy share link">
                            <I.IconLink />
                          </Button>
                          <Button size="sm" onClick={() => setShare({ id: item.id, filename: item.filename })} title="Sharing settings">
                            <I.IconShare />
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" loading={busy === `up-${item.key}`} disabled={uploading} onClick={() => void uploadLocal(item)} title="Upload to Google Drive">
                          <I.IconUpload />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" loading={busy === `rm-${item.key}`} onClick={() => void remove(item)} title="Delete">
                        <I.IconTrash />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
      {share && <ShareDialog open fileId={share.id} filename={share.filename} onClose={() => setShare(null)} />}
      <Modal open={!!rename} title="Rename file" onClose={() => setRename(null)}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitRename();
          }}
          className="flex gap-2"
        >
          <input autoFocus maxLength={200} value={rename?.value ?? ''} onChange={(e) => rename && setRename({ ...rename, value: e.target.value })} className="flex-1 rounded border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900" />
          <Button variant="primary" type="submit" loading={busy === 'rename'}>
            Save
          </Button>
        </form>
        {rename?.item.source === 'cloud' && <p className="mt-2 text-xs text-slate-500">The file is also renamed in Google Drive.</p>}
      </Modal>
    </div>
  );
}

mount(<Gallery />, 'SnapShare Gallery');
