import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { mount } from './mount';
import { Button, EmptyState, IconButton, Logo, ProgressBar, Spinner, useToast } from '@/components/ui';
import * as I from '@/components/icons';
import { EditorEngine, HIGHLIGHT_COLORS, STROKE_COLORS, type EngineStatus, type Tool, type EditorDraftState } from '@/features/editor/engine';
import { fitZoom, nextZoom } from '@/features/editor/geometry';
import { deleteDraft, getCapture, getDraft, newId, putCapture, saveDraft, type CaptureRecord } from '@/services/db';
import { copyImageToClipboard, downloadBlob } from '@/services/media';
import { friendlyError } from '@/services/api';
import { useSession } from '@/hooks';
import { useUpload } from '@/features/drive/useUpload';
import { ShareDialog } from '@/features/sharing/ShareDialog';

const TOOLS: { id: Tool; label: string; icon: ReactElement; key: string }[] = [
  { id: 'select', label: 'Select / move (V)', icon: <I.IconSelect />, key: 'v' },
  { id: 'highlight', label: 'Highlight (H)', icon: <I.IconHighlight />, key: 'h' },
  { id: 'arrow', label: 'Arrow (A)', icon: <I.IconArrow />, key: 'a' },
  { id: 'rect', label: 'Rectangle (R)', icon: <I.IconRect />, key: 'r' },
  { id: 'ellipse', label: 'Ellipse (E)', icon: <I.IconEllipse />, key: 'e' },
  { id: 'text', label: 'Text / comment (T)', icon: <I.IconText />, key: 't' },
  { id: 'blur', label: 'Blur sensitive area (B)', icon: <I.IconBlur />, key: 'b' },
  { id: 'crop', label: 'Crop (C)', icon: <I.IconCrop />, key: 'c' },
];

function Editor() {
  const toast = useToast();
  const params = new URLSearchParams(location.search);
  const captureId = params.get('id') ?? '';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<EditorEngine | null>(null);
  const [capture, setCapture] = useState<CaptureRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState(STROKE_COLORS[0]);
  const [hl, setHl] = useState(HIGHLIGHT_COLORS[0]);
  const [stroke, setStroke] = useState(4);
  const [busy, setBusy] = useState<string | null>(null);
  const [editedId, setEditedId] = useState<string | null>(null);
  const [shareAsset, setShareAsset] = useState<{ id: string; filename: string } | null>(null);
  const { session } = useSession();
  const { upload, uploading, progress, cancel } = useUpload();
  const draftTimer = useRef<number | null>(null);

  // The "original" is the root screenshot; editing an edited image keeps pointing at its root.
  const originalId = capture?.kind === 'edited' && capture.parentId ? capture.parentId : captureId;

  const scheduleDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      const eng = engineRef.current;
      if (!eng) return;
      if (eng.isPristine) void deleteDraft(captureId);
      else void saveDraft(captureId, { ...eng.draftState(), editedId: editedIdRef.current });
    }, 600);
  }, [captureId]);
  const editedIdRef = useRef<string | null>(null);
  editedIdRef.current = editedId;

  useEffect(() => {
    let disposed = false;
    (async () => {
      const rec = await getCapture(captureId);
      if (!rec || rec.kind === 'video') {
        setError('This screenshot is not available on this device.');
        return;
      }
      if (disposed || !canvasRef.current) return;
      setCapture(rec);
      document.title = `Edit · ${rec.filename}`;
      const eng = new EditorEngine(canvasRef.current, { onChange: scheduleDraft });
      engineRef.current = eng;
      const draft = (await getDraft(captureId))?.state as (EditorDraftState & { editedId?: string | null }) | undefined;
      await eng.load(rec.blob, draft ?? null);
      if (draft) {
        setEditedId(draft.editedId ?? null);
        toast('info', 'Restored your unsaved edits.');
      }
      const v = viewRef.current;
      if (v) eng.setZoom(fitZoom(eng.imageWidth, eng.imageHeight, v.clientWidth - 48, v.clientHeight - 48));
      eng.subscribe(setStatus);
    })().catch((e) => setError(friendlyError(e)));
    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captureId]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (engineRef.current?.status().dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const eng = () => engineRef.current!;
  const chooseTool = (t: Tool) => {
    setTool(t);
    eng().setTool(t);
  };

  /** Saves the current edit as a separate "edited" capture; the original stays untouched. */
  const saveEdited = useCallback(async (): Promise<CaptureRecord> => {
    const e = eng();
    const blob = await e.exportPng();
    const existing = editedId ? await getCapture(editedId) : undefined;
    const reuse = existing && !existing.cloud; // never overwrite a version already uploaded to Drive
    const id = reuse ? existing.id : newId();
    const base = capture!;
    const rec: CaptureRecord = {
      id,
      kind: 'edited',
      blob,
      mimeType: 'image/png',
      filename: `${base.kind === 'edited' ? base.filename : base.filename} (edited)`.replace(/( \(edited\))+$/, ' (edited)'),
      size: blob.size,
      width: e.imageWidth,
      height: e.imageHeight,
      durationMs: null,
      createdAt: existing?.createdAt ?? Date.now(),
      parentId: originalId,
      sourceUrl: base.sourceUrl,
      sourceTitle: base.sourceTitle,
      cloud: null,
    };
    await putCapture(rec);
    setEditedId(id);
    editedIdRef.current = id;
    e.markSaved();
    await deleteDraft(captureId);
    return rec;
  }, [capture, captureId, editedId, originalId]);

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

  const onSave = () =>
    act('save', async () => {
      const rec = await saveEdited();
      toast('success', 'Edited image saved. The original is kept separately.');
      if (session) await upload(rec.id); // stored in SnapShare/Screenshots in Drive
    });
  const onCopyEdited = () => act('copy', async () => (await copyImageToClipboard(await eng().exportPng()), toast('success', 'Edited image copied — paste it anywhere')));
  const onCopyOriginal = () => act('copy-o', async () => (await copyImageToClipboard((await getCapture(originalId))!.blob), toast('success', 'Original copied')));
  const onDownloadEdited = () => act('dl', async () => {
    const rec = await saveEdited();
    await downloadBlob(rec.blob, rec.filename);
    toast('success', 'Download started');
  });
  const onDownloadOriginal = () => act('dl-o', async () => {
    const orig = await getCapture(originalId);
    if (!orig) throw new Error('Original not found');
    await downloadBlob(orig.blob, orig.filename);
    toast('success', 'Download started');
  });
  const onUpload = (share: boolean) =>
    act(share ? 'share' : 'upload', async () => {
      if (!session) throw new Error('Sign in with Google (popup or Settings) to upload to Drive.');
      const e = eng();
      // Upload the edited version if there are edits; uploadCapture uploads the original first as its parent.
      const target = e.isPristine ? captureId : e.status().dirty || !editedId ? (await saveEdited()).id : editedId;
      const asset = await upload(target);
      if (asset && share) setShareAsset({ id: asset.id, filename: asset.name });
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      const engine = engineRef.current;
      if (!engine) return;
      const editingText = engine.canvas.getActiveObject()?.type === 'i-text' && (engine.canvas.getActiveObject() as unknown as { isEditing: boolean }).isEditing;
      if (editingText) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void (e.shiftKey ? engine.redo() : engine.undo());
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        void engine.redo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void onSave();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        engine.deleteSelected();
      } else if (e.key === 'Enter' && status?.cropRect) {
        void engine.applyCrop().then(() => setTool('select'));
      } else if (e.key === 'Escape') {
        engine.cancelCrop();
        chooseTool('select');
      } else if (!mod) {
        const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (t) chooseTool(t.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error)
    return (
      <div className="p-10">
        <EmptyState title={error}>
          <a className="text-brand-600 underline" href="gallery.html">
            Open gallery
          </a>
        </EmptyState>
      </div>
    );

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <Logo size={24} />
        <span className="truncate text-sm text-slate-500" title={capture?.filename}>
          {capture?.filename ?? 'Loading…'}
          {status?.dirty && <span className="ml-2 rounded bg-amber-100 px-1.5 text-[11px] text-amber-800">unsaved</span>}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {uploading && (
            <div className="flex w-48 items-center gap-2">
              <ProgressBar value={progress} />
              <button className="text-xs text-slate-500 underline" onClick={cancel}>
                Cancel
              </button>
            </div>
          )}
          <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void onSave()}>
            <I.IconSave /> Save
          </Button>
          <Button size="sm" loading={busy === 'copy'} onClick={() => void onCopyEdited()}>
            <I.IconCopy /> Copy
          </Button>
          <Button size="sm" loading={busy === 'dl'} onClick={() => void onDownloadEdited()}>
            <I.IconDownload /> Download PNG
          </Button>
          <Button size="sm" loading={busy === 'upload'} disabled={uploading} onClick={() => void onUpload(false)} title={session ? 'Upload to your Google Drive' : 'Sign in first'}>
            <I.IconUpload /> Drive
          </Button>
          <Button size="sm" loading={busy === 'share'} disabled={uploading} onClick={() => void onUpload(true)}>
            <I.IconShare /> Share
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-14 flex-col items-center gap-1 border-r border-slate-200 bg-white py-2 dark:border-slate-800 dark:bg-slate-900" aria-label="Tools">
          {TOOLS.map((t) => (
            <IconButton key={t.id} label={t.label} active={tool === t.id} onClick={() => chooseTool(t.id)}>
              {t.icon}
            </IconButton>
          ))}
          <div className="my-1 h-px w-8 bg-slate-200 dark:bg-slate-700" />
          <IconButton label="Undo (Ctrl+Z)" disabled={!status?.canUndo} onClick={() => void eng().undo()}>
            <I.IconUndo />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!status?.canRedo} onClick={() => void eng().redo()}>
            <I.IconRedo />
          </IconButton>
          <IconButton label="Delete selected (Del)" disabled={!status?.hasSelection} onClick={() => eng().deleteSelected()}>
            <I.IconTrash />
          </IconButton>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-3 py-1.5 text-xs dark:border-slate-800 dark:bg-slate-900">
            {tool === 'highlight' || (status?.hasSelection && !status.selectionIsText && tool === 'select') ? (
              <span className="flex items-center gap-1">
                Highlight
                {HIGHLIGHT_COLORS.map((c) => (
                  <button key={c} aria-label={`Highlight colour ${c}`} onClick={() => (setHl(c), eng().setHighlightColor(c))} className={`h-5 w-5 rounded-full border ${hl === c ? 'ring-2 ring-brand-500' : ''}`} style={{ background: c }} />
                ))}
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              Colour
              {STROKE_COLORS.map((c) => (
                <button key={c} aria-label={`Colour ${c}`} onClick={() => (setColor(c), eng().setColor(c))} className={`h-5 w-5 rounded-full border border-slate-300 ${color === c ? 'ring-2 ring-brand-500' : ''}`} style={{ background: c }} />
              ))}
              <input type="color" aria-label="Custom colour" value={color} onChange={(e) => (setColor(e.target.value), eng().setColor(e.target.value))} className="h-5 w-6" />
            </span>
            <label className="flex items-center gap-1">
              Stroke
              <input type="range" min={1} max={16} value={stroke} onChange={(e) => (setStroke(Number(e.target.value)), eng().setStrokeWidth(Number(e.target.value)))} />
            </label>
            {status?.textStyle && (
              <span className="flex items-center gap-1">
                <select aria-label="Font size" value={status.textStyle.fontSize} onChange={(e) => eng().setTextStyle({ fontSize: Number(e.target.value) })} className="rounded border border-slate-300 bg-white px-1 dark:border-slate-600 dark:bg-slate-800">
                  {[12, 14, 16, 20, 24, 32, 40, 56, 72].map((s) => (
                    <option key={s} value={s}>
                      {s}px
                    </option>
                  ))}
                </select>
                <IconButton label="Bold" active={status.textStyle.bold} onClick={() => eng().setTextStyle({ bold: !status.textStyle!.bold })}>
                  <b>B</b>
                </IconButton>
                <IconButton label="Italic" active={status.textStyle.italic} onClick={() => eng().setTextStyle({ italic: !status.textStyle!.italic })}>
                  <i>I</i>
                </IconButton>
                <IconButton label="Comment background" active={status.textStyle.background} onClick={() => eng().setTextStyle({ background: !status.textStyle!.background })}>
                  ▣
                </IconButton>
              </span>
            )}
            {tool === 'crop' && (
              <span className="flex items-center gap-2">
                {status?.cropRect ? (
                  <>
                    <span>
                      {Math.round(status.cropRect.width)} × {Math.round(status.cropRect.height)}
                    </span>
                    <Button size="sm" variant="primary" onClick={() => void eng().applyCrop().then(() => setTool('select'))}>
                      Apply crop
                    </Button>
                    <Button size="sm" onClick={() => eng().cancelCrop()}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <span className="text-slate-500">Drag on the image to choose the crop area.</span>
                )}
              </span>
            )}
            {tool === 'blur' && <span className="text-slate-500">Drag over sensitive content. Pixels are permanently replaced in the exported image.</span>}
            <span className="ml-auto flex items-center gap-1">
              <IconButton label="Zoom out" onClick={() => eng().setZoom(nextZoom(status?.zoom ?? 1, -1))}>
                <I.IconZoomOut />
              </IconButton>
              <button className="w-12 text-center tabular-nums" onClick={() => eng().setZoom(1)} title="Actual size">
                {Math.round((status?.zoom ?? 1) * 100)}%
              </button>
              <IconButton label="Zoom in" onClick={() => eng().setZoom(nextZoom(status?.zoom ?? 1, 1))}>
                <I.IconZoomIn />
              </IconButton>
              <Button size="sm" variant="ghost" onClick={() => viewRef.current && eng().setZoom(fitZoom(eng().imageWidth, eng().imageHeight, viewRef.current.clientWidth - 48, viewRef.current.clientHeight - 48))}>
                Fit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => eng().clearAnnotations()}>
                Clear annotations
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void eng().resetAll()} title="Discard all edits and crops (undoable)">
                <I.IconReset /> Reset
              </Button>
            </span>
          </div>
          <div ref={viewRef} className="relative min-h-0 flex-1 overflow-auto bg-slate-200 p-6 dark:bg-slate-950">
            {!status && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Spinner className="h-8 w-8" />
              </div>
            )}
            <div className="mx-auto w-fit shadow-xl">
              <canvas ref={canvasRef} />
            </div>
          </div>
          <footer className="flex items-center gap-3 border-t border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900">
            <span>
              {status?.width} × {status?.height}px
            </span>
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" loading={busy === 'copy-o'} onClick={() => void onCopyOriginal()}>
                Copy original
              </Button>
              <Button size="sm" variant="ghost" loading={busy === 'dl-o'} onClick={() => void onDownloadOriginal()}>
                Download original
              </Button>
            </span>
          </footer>
        </main>
      </div>
      {shareAsset && <ShareDialog open fileId={shareAsset.id} filename={shareAsset.filename} onClose={() => setShareAsset(null)} />}
    </div>
  );
}

mount(<Editor />, 'SnapShare Editor');
