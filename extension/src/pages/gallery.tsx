import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  const [useFull, setUseFull] = useState(false);
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
          // Show Drive's thumbnail as a plain <img> (no fetch → no CORS errors). If it is missing or
          // fails to load, fall back to the (bounded) image itself via the authenticated Drive API.
          const thumb = !useFull ? drive.thumbnailUrl(item.file!) : null;
          if (thumb) {
            if (!cancelled) setUrl(thumb);
            return;
          }
          const blob = item.size <= 15 * 1024 * 1024 ? await drive.downloadBlob(item.id) : null;
          if (blob && !cancelled) created = URL.createObjectURL(blob);
          else if (!cancelled) setFailed(true);
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
  }, [item.id, item.source, item.mediaType, item.status, item.file, item.size, useFull]);
  return (
    <div ref={ref} className="flex aspect-video items-center justify-center overflow-hidden bg-slate-100 dark:bg-slate-800">
      {item.mediaType === 'video' ? (
        <I.IconVideo width={32} height={32} className="text-slate-400" />
      ) : url ? (
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover object-top"
          onError={() => {
            if (item.source === 'cloud' && !useFull) {
              setUrl(null);
              setUseFull(true);
            } else setFailed(true);
          }}
        />
      ) : failed ? (
        <span className="text-xs text-slate-400">No preview</span>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
  </svg>
);

/** Fixed-size icon action: the spinner replaces the icon while busy, so neighbours never shift. */
function ActionBtn({ label, loading, danger, disabled, onClick, children }: { label: string; loading?: boolean; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" className={`h-8 w-9 shrink-0 px-0! ${danger ? 'text-red-600 dark:text-red-400' : ''}`} disabled={disabled || loading} onClick={onClick} title={label} aria-label={label}>
      {loading ? <Spinner className="h-3.5 w-3.5" /> : children}
    </Button>
  );
}

const MAX_ZOOM = 8;

/**
 * Image viewer with zoom: buttons (− / + / Fit), Ctrl+mouse wheel at the cursor, double-click,
 * keys + − 0. When zoomed in, drag the image (or scroll) to move around.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(1); // scale at which the whole image fits the box
  const [zoom, setZoom] = useState(1); // multiplier on top of `fit` (1 = fit)
  const anchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box || !natural) return;
    setFit(Math.min(1, box.clientWidth / natural.w, box.clientHeight / natural.h));
  }, [natural]);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  /** Zooms keeping the point under (cx, cy) — box coordinates — fixed; defaults to the centre. */
  const zoomTo = useCallback((next: number, cx?: number, cy?: number) => {
    const box = boxRef.current;
    if (!box) return;
    const z = Math.min(MAX_ZOOM, Math.max(1, next));
    const px = cx ?? box.clientWidth / 2;
    const py = cy ?? box.clientHeight / 2;
    anchor.current = { fx: (box.scrollLeft + px) / box.scrollWidth, fy: (box.scrollTop + py) / box.scrollHeight, cx: px, cy: py };
    setZoom(z);
  }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const a = anchor.current;
    if (!box || !a) return;
    anchor.current = null;
    box.scrollLeft = a.fx * box.scrollWidth - a.cx;
    box.scrollTop = a.fy * box.scrollHeight - a.cy;
  }, [zoom]);

  // Ctrl + wheel zooms at the cursor (non-passive so the page itself doesn't zoom).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = box.getBoundingClientRect();
      zoomTo(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [zoom, zoomTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement).tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || e.ctrlKey || e.metaKey) return;
      if (e.key === '+' || e.key === '=') zoomTo(zoom * 1.25);
      else if (e.key === '-' || e.key === '_') zoomTo(zoom / 1.25);
      else if (e.key === '0') zoomTo(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, zoomTo]);

  const scale = fit * zoom;
  const zoomed = zoom > 1.001;
  return (
    <div className="relative w-full">
      <div
        ref={boxRef}
        className={`h-[60vh] w-full overflow-auto rounded-lg bg-slate-100 dark:bg-slate-950 ${zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
        onDoubleClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          zoomTo(zoomed ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
        }}
        onMouseDown={(e) => {
          if (!zoomed || e.button !== 0) return;
          e.preventDefault();
          pan.current = { x: e.clientX, y: e.clientY, sl: e.currentTarget.scrollLeft, st: e.currentTarget.scrollTop };
        }}
        onMouseMove={(e) => {
          const p = pan.current;
          if (!p) return;
          e.currentTarget.scrollLeft = p.sl - (e.clientX - p.x);
          e.currentTarget.scrollTop = p.st - (e.clientY - p.y);
        }}
        onMouseUp={() => (pan.current = null)}
        onMouseLeave={() => (pan.current = null)}
      >
        <div className="flex min-h-full min-w-full w-max items-center justify-center">
          <img
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={natural ? { width: natural.w * scale, height: natural.h * scale, maxWidth: 'none' } : { maxHeight: '60vh' }}
            className="select-none"
          />
        </div>
      </div>
      <div className="absolute bottom-2 right-4 flex items-center gap-1 rounded-lg bg-white/90 p-1 shadow dark:bg-slate-800/90">
        <ActionBtn label="Zoom out (−)" disabled={!zoomed} onClick={() => zoomTo(zoom / 1.25)}>
          <span className="text-base leading-none">−</span>
        </ActionBtn>
        <span className="w-12 text-center text-xs tabular-nums text-slate-600 dark:text-slate-300" title="Size compared with the original image">
          {Math.round(scale * 100)}%
        </span>
        <ActionBtn label="Zoom in (+)" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom * 1.25)}>
          <span className="text-base leading-none">+</span>
        </ActionBtn>
        <Button size="sm" className="h-8" disabled={!zoomed} onClick={() => zoomTo(1)} title="Fit to window (0)">
          Fit
        </Button>
      </div>
    </div>
  );
}

function PreviewModal({ item, index, total, onPrev, onNext, onClose, actions }: { item: GalleryItem; index: number; total: number; onPrev: () => void; onNext: () => void; onClose: () => void; actions: ReactNode }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    setErr(null);
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
    // Keyed on the item identity: list items are re-created on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.key, item.status]);
  return (
    <Modal open title={item.filename} onClose={onClose} wide>
      <div className="flex min-h-[200px] items-center justify-center">
        {err ? <p className="text-red-600">{err}</p> : !src ? <Spinner /> : item.mediaType === 'video' ? <video key={item.key} src={src} controls autoPlay className="max-h-[60vh] w-full bg-black" /> : <ZoomableImage key={item.key} src={src} alt={item.filename} />}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-1">{actions}</div>
      <div className="mt-3 flex items-center justify-center gap-4">
        <ActionBtn label="Previous (←)" disabled={index <= 0} onClick={onPrev}>
          <Chevron dir="left" />
        </ActionBtn>
        <span className="min-w-16 text-center text-sm text-slate-500">
          {index + 1} / {total}
        </span>
        <ActionBtn label="Next (→)" disabled={index >= total - 1} onClick={onNext}>
          <Chevron dir="right" />
        </ActionBtn>
      </div>
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
  const [preview, setPreview] = useState<number | null>(null); // index into `items`
  const [rename, setRename] = useState<{ item: GalleryItem; value: string } | null>(null);
  const [share, setShare] = useState<{ id: string; filename: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
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
  // After a delete the same index shows the next file; close when nothing is left.
  const previewIndex = preview === null || !items.length ? null : Math.min(preview, items.length - 1);
  const previewItem = previewIndex === null ? null : items[previewIndex];
  const dialogOpen = !!rename || !!share;

  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (dialogOpen || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'VIDEO') return;
      if (e.key === 'ArrowLeft' && previewIndex > 0) setPreview(previewIndex - 1);
      else if (e.key === 'ArrowRight' && previewIndex < items.length - 1) setPreview(previewIndex + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIndex, items.length, dialogOpen]);

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

  /** Deletes one item without confirmation (Drive file for cloud items, local copy for device items). */
  const deleteItem = async (item: GalleryItem) => {
    if (item.status === 'missing') {
      // Deleted in Drive already: drop the dead link and the local copy.
      await deleteCapture(item.id);
    } else if (item.source === 'local') {
      await deleteCapture(item.id);
    } else {
      await drive.delete(item.id);
      // Unlink any local copy so it can be re-uploaded later.
      const linked = local.find((l) => l.cloud?.driveFileId === item.id);
      if (linked) await updateCapture(linked.id, { cloud: null });
    }
  };

  const remove = (item: GalleryItem) =>
    act(`rm-${item.key}`, async () => {
      const msg =
        item.source === 'cloud' && item.status !== 'missing'
          ? `Permanently delete “${item.filename}” from your Google Drive? Anyone it was shared with loses access.`
          : `Delete “${item.filename}” from this device?`;
      if (!confirm(msg)) return;
      await deleteItem(item);
      setSelected((sel) => {
        const n = new Set(sel);
        n.delete(item.key);
        return n;
      });
      toast('success', 'Deleted');
      await load();
    });

  const toggle = (key: string) =>
    setSelected((sel) => {
      const n = new Set(sel);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const removeSelected = async () => {
    const targets = items.filter((i) => selected.has(i.key));
    if (!targets.length) return;
    const inDrive = targets.filter((i) => i.source === 'cloud' && i.status !== 'missing').length;
    const onDevice = targets.length - inDrive;
    const parts = [inDrive ? `${inDrive} from your Google Drive (permanent; shared people lose access)` : '', onDevice ? `${onDevice} from this device` : ''].filter(Boolean);
    if (!confirm(`Delete ${targets.length} file(s): ${parts.join(' and ')}?`)) return;
    let failed = 0;
    setBulk({ done: 0, total: targets.length });
    for (const [i, item] of targets.entries()) {
      try {
        await deleteItem(item);
      } catch {
        failed++;
      }
      setBulk({ done: i + 1, total: targets.length });
    }
    setBulk(null);
    setSelected(new Set());
    if (failed) toast('error', `${targets.length - failed} deleted, ${failed} failed. Try again for the remaining files.`);
    else toast('success', `${targets.length} file(s) deleted`);
    await load();
  };

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

  /** Action buttons shared by the cards and the preview. Fixed sizes, so nothing moves while one is busy. */
  const renderActions = (item: GalleryItem) =>
    item.status === 'missing' ? (
      <>
        <Button size="sm" loading={busy === `up-${item.key}`} disabled={uploading} onClick={() => void updateCapture(item.id, { cloud: null }).then(() => uploadLocal(item))} title="Upload again">
          <I.IconUpload /> Re-upload
        </Button>
        <ActionBtn label="Delete" danger loading={busy === `rm-${item.key}`} onClick={() => void remove(item)}>
          <I.IconTrash />
        </ActionBtn>
      </>
    ) : (
      <>
        {item.source === 'local' && item.mediaType !== 'video' && (
          <Button size="sm" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${item.id}`) })}>
            <I.IconEdit /> Edit
          </Button>
        )}
        <ActionBtn label="Download" loading={busy === `dl-${item.key}`} onClick={() => void download(item)}>
          <I.IconDownload />
        </ActionBtn>
        {item.mediaType !== 'video' && (
          <ActionBtn label="Copy image" loading={busy === `cp-${item.key}`} onClick={() => void copyImage(item)}>
            <I.IconCopy />
          </ActionBtn>
        )}
        <ActionBtn label="Rename" onClick={() => setRename({ item, value: item.filename })}>
          <I.IconText />
        </ActionBtn>
        {item.source === 'cloud' ? (
          <>
            <ActionBtn label="Copy share link" loading={busy === `ln-${item.key}`} onClick={() => void copyLink(item)}>
              <I.IconLink />
            </ActionBtn>
            <ActionBtn label="Sharing settings" onClick={() => setShare({ id: item.id, filename: item.filename })}>
              <I.IconShare />
            </ActionBtn>
          </>
        ) : (
          <ActionBtn label="Upload to Google Drive" loading={busy === `up-${item.key}`} disabled={uploading} onClick={() => void uploadLocal(item)}>
            <I.IconUpload />
          </ActionBtn>
        )}
        <ActionBtn label="Delete" danger loading={busy === `rm-${item.key}`} onClick={() => void remove(item)}>
          <I.IconTrash />
        </ActionBtn>
      </>
    );

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
    <div className="mx-auto max-w-7xl px-6 pb-6">
      {/* Header, filters and selection actions stay pinned while the grid scrolls. */}
      <div className="sticky top-0 z-20 -mx-6 mb-2 border-b border-slate-200 bg-slate-50 px-6 pt-6 dark:border-slate-800 dark:bg-slate-950">
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
      {items.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800/60">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={items.every((i) => selected.has(i.key))}
              ref={(el) => {
                if (el) el.indeterminate = selected.size > 0 && !items.every((i) => selected.has(i.key));
              }}
              onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.key)) : new Set())}
            />
            Select all
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-slate-500">{items.filter((i) => selected.has(i.key)).length} selected</span>
              <Button size="sm" variant="danger" loading={!!bulk} onClick={() => void removeSelected()}>
                <I.IconTrash /> {bulk ? `Deleting ${bulk.done}/${bulk.total}…` : 'Delete selected'}
              </Button>
              <Button size="sm" variant="ghost" disabled={!!bulk} onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </>
          )}
        </div>
      )}
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
            <li
              key={item.key}
              className={`relative overflow-hidden rounded-xl border bg-white shadow-sm dark:bg-slate-900 ${selected.has(item.key) || highlight === item.id ? 'border-brand-500 ring-2 ring-brand-500' : 'border-slate-200 dark:border-slate-800'}`}
            >
              <label className="absolute left-2 top-2 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-white/90 shadow dark:bg-slate-900/90" title="Select">
                <input type="checkbox" aria-label={`Select ${item.filename}`} checked={selected.has(item.key)} onChange={() => toggle(item.key)} className="h-4 w-4" />
              </label>
              <button className="block w-full" onClick={() => setPreview(items.indexOf(item))} aria-label={`Preview ${item.filename}`}>
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
                <div className="mt-2 flex flex-wrap items-center gap-1">{renderActions(item)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {previewItem && previewIndex !== null && (
        <PreviewModal
          item={previewItem}
          index={previewIndex}
          total={items.length}
          onPrev={() => setPreview(Math.max(0, previewIndex - 1))}
          onNext={() => setPreview(Math.min(items.length - 1, previewIndex + 1))}
          onClose={() => !dialogOpen && setPreview(null)}
          actions={renderActions(previewItem)}
        />
      )}
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
