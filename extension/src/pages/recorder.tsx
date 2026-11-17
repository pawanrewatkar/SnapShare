import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatDuration } from '@snapshare/shared';
import { mount } from './mount';
import { Button, EmptyState, Logo, ProgressBar, Spinner, useToast } from '@/components/ui';
import { IconDownload, IconMonitor, IconPause, IconPlay, IconShare, IconStop, IconTrash, IconUpload } from '@/components/icons';
import { RecorderSession } from '@/features/recording/session';
import { audioWarnings, detectOs, micErrorMessage, planAudio } from '@/features/recording/audio';
import { deleteCapture, getCapture, newId, putCapture, type CaptureRecord } from '@/services/db';
import { buildFilename, getSettings } from '@/services/settings';
import { downloadBlob } from '@/services/media';
import { friendlyError } from '@/services/api';
import { useNow, useObjectUrl, useSession } from '@/hooks';
import { useUpload } from '@/features/drive/useUpload';
import { ShareDialog } from '@/features/sharing/ShareDialog';
import type { RecorderCommand, RecorderEvent } from '@/types/messages';

const emit = (event: RecorderEvent) => chrome.runtime.sendMessage({ type: 'rec:event', event }).catch(() => undefined);

function displayMediaError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError') return 'Screen sharing was cancelled or permission was denied.';
  if (name === 'NotFoundError') return 'No screen or window is available to capture.';
  if (name === 'NotReadableError') return 'The operating system blocked screen capture (check screen-recording permission for Chrome).';
  return (e as Error)?.message || 'Screen capture failed';
}

/* ---------------- Screen screenshot ---------------- */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Grabs one frame from a display stream (ImageCapture works even while this window is minimised). */
async function grabFrame(stream: MediaStream): Promise<ImageBitmap> {
  const track = stream.getVideoTracks()[0];
  const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
  if (IC) {
    try {
      return await new IC(track).grabFrame();
    } catch {
      /* fall back to a <video> element */
    }
  }
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  await sleep(300);
  return createImageBitmap(video);
}

async function bitmapToPng(bmp: ImageBitmap, crop?: { x: number; y: number; width: number; height: number }): Promise<Blob> {
  const r = crop ?? { x: 0, y: 0, width: bmp.width, height: bmp.height };
  const canvas = document.createElement('canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext('2d')!.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/png'));
}

/** Saves the screenshot, then lets the service worker upload it to Drive and open the editor. */
async function saveScreenShot(blob: Blob, width: number, height: number, split: boolean) {
  const settings = await getSettings();
  const id = newId();
  await putCapture({
    id,
    kind: 'screenshot',
    blob,
    mimeType: 'image/png',
    filename: buildFilename(settings.filenamePattern, { title: split ? 'Split view' : 'Screen', kind: 'screenshot' }),
    size: blob.size,
    width,
    height,
    durationMs: null,
    createdAt: Date.now(),
    parentId: null,
    sourceUrl: null,
    sourceTitle: split ? 'Split view capture' : 'Screen capture',
    cloud: null,
  });
  const res = (await chrome.runtime.sendMessage({ type: 'screen:captured', captureId: id }).catch(() => null)) as { ok?: boolean } | null;
  if (res?.ok) window.close(); // the editor opened in a normal browser tab
  else location.replace(`editor.html?id=${encodeURIComponent(id)}`);
}

const thisWindow = () => chrome.windows.getCurrent();

/** Chrome's desktop picker ("Window" first) without a button click; null = the user cancelled. */
function chooseDesktop(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(['window', 'screen'], (id) => {
        const le = chrome.runtime.lastError;
        if (le) reject(new Error(le.message));
        else resolve(id || null);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function ScreenScreenshot({ split, auto }: { split: 'visible' | 'region' | null; auto?: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<ImageBitmap | null>(null); // region mode: image to crop
  const started = useRef(false);

  // Split view: open Chrome's picker straight away; fall back to the button if that isn't possible.
  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    void (async () => {
      let id: string | null;
      try {
        id = await chooseDesktop();
      } catch {
        return; // picker unavailable: the page shows the "Choose the Chrome window" button instead
      }
      if (!id) return window.close(); // cancelled
      await pick(() =>
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 7680, maxHeight: 4320 } } as unknown as MediaTrackConstraints,
        }),
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const pick = async (
    acquire: () => Promise<MediaStream> = () =>
      navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5, ...(split ? { displaySurface: 'window' } : {}) },
        audio: false,
        ...({ selfBrowserSurface: 'exclude' } as object),
      } as DisplayMediaStreamOptions),
  ) => {
    setBusy(true);
    setErr(null);
    let stream: MediaStream | null = null;
    try {
      stream = await acquire();
      // Get this small window out of the way so it isn't in the picture (e.g. "Entire screen").
      const win = await thisWindow();
      if (win.id !== undefined) await chrome.windows.update(win.id, { state: 'minimized' }).catch(() => undefined);
      await sleep(600);
      const bmp = await grabFrame(stream);
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      if (split === 'region') {
        if (win.id !== undefined) await chrome.windows.update(win.id, { state: 'maximized', focused: true }).catch(() => undefined);
        setShot(bmp);
        return;
      }
      if (win.id !== undefined) await chrome.windows.update(win.id, { state: 'normal' }).catch(() => undefined);
      await saveScreenShot(await bitmapToPng(bmp), bmp.width, bmp.height, !!split);
    } catch (e) {
      setErr(displayMediaError(e));
      const win = await thisWindow().catch(() => null);
      if (win?.id !== undefined) await chrome.windows.update(win.id, { state: 'normal', focused: true }).catch(() => undefined);
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setBusy(false);
    }
  };

  if (shot)
    return (
      <RegionCrop
        bitmap={shot}
        onCancel={() => window.close()}
        onCapture={async (r) => {
          await saveScreenShot(await bitmapToPng(shot, r), r.width, r.height, true);
        }}
      />
    );

  return (
    <Centered>
      <IconMonitor width={40} height={40} className="text-brand-600" />
      <h1 className="text-xl font-semibold">{split ? 'Capture your split view' : 'Capture your screen or a window'}</h1>
      {split ? (
        <p className="max-w-md rounded bg-brand-50 p-3 text-sm text-brand-700">
          Your tab is in split view. Click the button, choose <b>Window</b> and pick the Chrome window showing your split pages, then click <b>Share</b>. All panes are captured in one image
          {split === 'region' ? ' — then drag to select the area you want.' : '.'}
        </p>
      ) : (
        <p className="max-w-md text-center text-sm text-slate-500">Chrome will ask which screen, window or tab to capture. SnapShare grabs a single still image and stops sharing immediately.</p>
      )}
      {err && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{err}</p>}
      <Button variant="primary" loading={busy} onClick={() => void pick()}>
        {split ? 'Choose the Chrome window' : 'Choose screen or window'}
      </Button>
    </Centered>
  );
}

type Box = { x: number; y: number; width: number; height: number };

/** Drag to select an area of a captured image; drag inside to move it, drag edges/corners to resize. */
function RegionCrop({ bitmap, onCancel, onCapture }: { bitmap: ImageBitmap; onCancel: () => void; onCapture: (r: Box) => Promise<void> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState<Box | null>(null); // in displayed (CSS) pixels
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ mode: 'new' | 'move' | 'resize'; x: number; y: number; orig: Box; edges: { l: boolean; r: boolean; t: boolean; b: boolean } } | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (c) {
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext('2d')!.drawImage(bitmap, 0, 0);
    }
  }, [bitmap]);

  const pos = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(r.width, e.clientX - r.left)), y: Math.max(0, Math.min(r.height, e.clientY - r.top)), w: r.width, h: r.height };
  };
  const hit = (px: number, py: number) => {
    if (!box) return null;
    const T = 8;
    const e = { l: Math.abs(px - box.x) <= T, r: Math.abs(px - (box.x + box.width)) <= T, t: Math.abs(py - box.y) <= T, b: Math.abs(py - (box.y + box.height)) <= T };
    const near = px >= box.x - T && px <= box.x + box.width + T && py >= box.y - T && py <= box.y + box.height + T;
    if (near && (e.l || e.r || e.t || e.b)) return { mode: 'resize' as const, edges: e };
    if (px > box.x && px < box.x + box.width && py > box.y && py < box.y + box.height) return { mode: 'move' as const, edges: e };
    return null;
  };
  const cursorFor = (h: ReturnType<typeof hit>) => {
    if (!h) return 'crosshair';
    if (h.mode === 'move') return 'move';
    const { l, r, t, b } = h.edges;
    if ((l && t) || (r && b)) return 'nwse-resize';
    if ((r && t) || (l && b)) return 'nesw-resize';
    return l || r ? 'ew-resize' : 'ns-resize';
  };
  const norm = (x1: number, y1: number, x2: number, y2: number, w: number, h: number): Box => {
    const cx1 = Math.max(0, Math.min(w, Math.min(x1, x2)));
    const cy1 = Math.max(0, Math.min(h, Math.min(y1, y2)));
    const cx2 = Math.max(0, Math.min(w, Math.max(x1, x2)));
    const cy2 = Math.max(0, Math.min(h, Math.max(y1, y2)));
    return { x: cx1, y: cy1, width: cx2 - cx1, height: cy2 - cy1 };
  };

  const capture = async () => {
    const c = canvasRef.current;
    if (!c || !box || box.width < 4 || box.height < 4) return;
    const s = bitmap.width / c.getBoundingClientRect().width;
    const r = { x: Math.round(box.x * s), y: Math.round(box.y * s), width: Math.max(1, Math.round(box.width * s)), height: Math.max(1, Math.round(box.height * s)) };
    setSaving(true);
    try {
      await onCapture(r);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') void capture();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex flex-col items-center gap-3 p-4">
      <p className="text-sm text-slate-500">Drag to select an area · drag the selection to move it or its edges to resize · Enter to capture · Esc to cancel</p>
      <div className="relative inline-block select-none overflow-hidden">
        <canvas
          ref={canvasRef}
          className="block max-h-[78vh] max-w-full"
          style={{ cursor: 'crosshair' }}
          onMouseDown={(e) => {
            const p = pos(e);
            const h = hit(p.x, p.y);
            if (h) drag.current = { mode: h.mode, x: p.x, y: p.y, orig: box!, edges: h.edges };
            else {
              drag.current = { mode: 'new', x: p.x, y: p.y, orig: { x: p.x, y: p.y, width: 0, height: 0 }, edges: { l: false, r: false, t: false, b: false } };
              setBox({ x: p.x, y: p.y, width: 0, height: 0 });
            }
          }}
          onMouseMove={(e) => {
            const p = pos(e);
            const d = drag.current;
            if (!d) {
              e.currentTarget.style.cursor = cursorFor(hit(p.x, p.y));
              return;
            }
            const o = d.orig;
            if (d.mode === 'new') setBox(norm(d.x, d.y, p.x, p.y, p.w, p.h));
            else if (d.mode === 'move')
              setBox({ ...o, x: Math.max(0, Math.min(p.w - o.width, o.x + p.x - d.x)), y: Math.max(0, Math.min(p.h - o.height, o.y + p.y - d.y)) });
            else {
              const dx = p.x - d.x;
              const dy = p.y - d.y;
              setBox(norm(o.x + (d.edges.l ? dx : 0), o.y + (d.edges.t ? dy : 0), o.x + o.width + (d.edges.r ? dx : 0), o.y + o.height + (d.edges.b ? dy : 0), p.w, p.h));
            }
          }}
          onMouseUp={() => {
            drag.current = null;
            if (box && (box.width < 4 || box.height < 4)) setBox(null);
          }}
        />
        {box && box.width > 0 && (
          <div
            className="pointer-events-none absolute outline-2 outline-brand-500"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height, boxShadow: '0 0 0 9999px rgba(15,23,42,.45)', outlineStyle: 'solid' }}
          />
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={onCancel}>Cancel (Esc)</Button>
        <Button variant="primary" loading={saving} disabled={!box || box.width < 4 || box.height < 4} onClick={() => void capture()}>
          Capture (Enter)
        </Button>
      </div>
    </div>
  );
}

/* ---------------- Screen recording host ---------------- */
function ScreenRecorder({ recordingId, mic, audio, split, onDone }: { recordingId: string; mic: boolean; audio: boolean; split?: boolean; onDone: (id: string | null) => void }) {
  const [phase, setPhase] = useState<'pick' | 'recording' | 'paused' | 'saving'>('pick');
  const [err, setErr] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [pausedMs, setPausedMs] = useState(0);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [bytes, setBytes] = useState(0);
  const session = useRef<RecorderSession | null>(null);
  const now = useNow(phase === 'recording');
  const plan = planAudio('screen', audio, mic, detectOs());

  useEffect(() => {
    const onCmd = (msg: RecorderCommand, _s: chrome.runtime.MessageSender, respond: (r: unknown) => void) => {
      if (msg?.target !== 'recorder' || msg.type === 'start-tab' || msg.recordingId !== recordingId) return;
      if (msg.type === 'pause') session.current?.pause();
      if (msg.type === 'resume') session.current?.resume();
      if (msg.type === 'stop') void session.current?.stop('user');
      respond({ ok: true });
    };
    chrome.runtime.onMessage.addListener(onCmd);
    const warn = (e: BeforeUnloadEvent) => {
      if (session.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      chrome.runtime.onMessage.removeListener(onCmd);
      window.removeEventListener('beforeunload', warn);
    };
  }, [recordingId]);

  const start = async () => {
    setErr(null);
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: plan.requestSystemAudio,
        // Chrome-specific hints (ignored elsewhere)
        ...({ systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' } as object),
        // Split view: preselect the "Window" tab of Chrome's picker so both panes are recorded.
        ...(split ? { video: { frameRate: 30, displaySurface: 'window' } } : {}),
      } as DisplayMediaStreamOptions);
    } catch (e) {
      setErr(displayMediaError(e));
      return;
    }
    let micStream: MediaStream | null = null;
    let micError: string | null = null;
    if (plan.requestMicrophone) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        micError = micErrorMessage(e);
      }
    }
    const surface = (display.getVideoTracks()[0]?.getSettings() as { displaySurface?: string }).displaySurface ?? 'monitor';
    const s = new RecorderSession({
      recordingId,
      video: new MediaStream(display.getVideoTracks()),
      sourceAudio: display.getAudioTracks()[0] ?? null,
      mic: micStream,
      playbackSourceAudio: false,
      title: `Screen recording (${surface})`,
      onEvent: (e) => {
        void emit(e);
        if (e.kind === 'paused') {
          setPhase('paused');
          setPausedAt(Date.now());
        }
        if (e.kind === 'resumed') {
          setPhase('recording');
          setPausedAt((p) => {
            if (p) setPausedMs((m) => m + Date.now() - p);
            return null;
          });
        }
        if (e.kind === 'progress') setBytes(e.bytes);
        if (e.kind === 'warning') setWarnings((w) => [...w, e.message]);
        if (e.kind === 'error') setErr(e.message);
        if (e.kind === 'stopped') {
          session.current = null;
          onDone(e.captureId);
        }
      },
    });
    session.current = s;
    try {
      const { audio: got } = s.start();
      const w = audioWarnings(plan, { system: got.systemAudio, mic: got.microphone, micError });
      setWarnings(w);
      setStartedAt(Date.now());
      setPhase('recording');
      void emit({ kind: 'started', recordingId, warnings: w, audio: got });
    } catch (e) {
      display.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      session.current = null;
      setErr((e as Error).message);
    }
  };

  const elapsed = startedAt ? (pausedAt ?? now) - startedAt - pausedMs : 0;

  if (phase === 'pick')
    return (
      <Centered>
        <IconMonitor width={40} height={40} className="text-brand-600" />
        <h1 className="text-xl font-semibold">Record your screen or a window</h1>
        {split && (
          <p className="max-w-md rounded bg-brand-50 p-2 text-sm text-brand-700">
            Your tab is in split view. To record all panes, choose <b>Window</b> and pick this Chrome window. To record several windows side by side, choose <b>Entire screen</b>.
          </p>
        )}
        <ul className="max-w-md list-disc space-y-1 pl-5 text-sm text-slate-500">
          {plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {mic && <li>Chrome will ask for microphone access if it hasn’t been granted.</li>}
          <li>Keep this tab open while recording. You can control the recording from the SnapShare popup.</li>
        </ul>
        {err && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{err}</p>}
        <Button variant="primary" onClick={() => void start()}>
          Choose what to share
        </Button>
      </Centered>
    );

  return (
    <Centered>
      <div className="flex items-center gap-3 font-mono text-4xl">
        <span className={`h-4 w-4 rounded-full ${phase === 'recording' ? 'animate-pulse bg-red-600' : 'bg-amber-500'}`} />
        {formatDuration(elapsed)}
      </div>
      <p className="text-sm text-slate-500">
        {phase === 'saving' ? 'Saving…' : phase === 'paused' ? 'Paused' : 'Recording'} · {formatBytes(bytes)}
      </p>
      {warnings.map((w) => (
        <p key={w} className="max-w-md rounded bg-amber-50 p-2 text-sm text-amber-800">
          {w}
        </p>
      ))}
      {err && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{err}</p>}
      <div className="flex gap-2">
        {phase === 'recording' && (
          <Button onClick={() => session.current?.pause()}>
            <IconPause /> Pause
          </Button>
        )}
        {phase === 'paused' && (
          <Button onClick={() => session.current?.resume()}>
            <IconPlay /> Resume
          </Button>
        )}
        <Button variant="danger" loading={phase === 'saving'} onClick={() => (setPhase('saving'), void chrome.runtime.sendMessage({ type: 'rec:stop' }))}>
          <IconStop /> Stop
        </Button>
      </div>
    </Centered>
  );
}

/* ---------------- Video preview ---------------- */
function VideoPreview({ id }: { id: string }) {
  const toast = useToast();
  const [rec, setRec] = useState<CaptureRecord | null | undefined>(undefined);
  const url = useObjectUrl(rec?.blob);
  const { session } = useSession();
  const { upload, uploading, progress, cancel } = useUpload();
  const [share, setShare] = useState<{ id: string; filename: string } | null>(null);

  useEffect(() => {
    void getCapture(id).then((r) => setRec(r ?? null));
  }, [id]);

  if (rec === undefined)
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  if (rec === null)
    return (
      <Centered>
        <EmptyState title="Recording not found on this device" />
      </Centered>
    );

  const doUpload = async (andShare: boolean) => {
    if (!session) return toast('error', 'Sign in with Google from the popup or Settings first.');
    const asset = await upload(rec.id);
    if (asset) {
      setRec((await getCapture(rec.id)) ?? rec);
      if (andShare) setShare({ id: asset.id, filename: asset.name });
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 text-lg font-semibold">{rec.filename}</h1>
      <p className="mb-4 text-sm text-slate-500">
        WebM · {formatBytes(rec.size)} {rec.durationMs ? `· ${formatDuration(rec.durationMs)}` : ''} · {new Date(rec.createdAt).toLocaleString()}
        {rec.recovered && ' · recovered after an interruption'}
        {rec.cloud && ' · saved to Google Drive'}
      </p>
      {url && <video src={url} controls className="mb-4 max-h-[70vh] w-full rounded-lg bg-black" />}
      {uploading && (
        <div className="mb-3 flex items-center gap-2">
          <ProgressBar value={progress} />
          <span className="text-xs tabular-nums">{progress !== null ? `${Math.round(progress * 100)}%` : ''}</span>
          <button className="text-xs underline" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void downloadBlob(rec.blob, rec.filename).then(() => toast('success', 'Download started'), (e) => toast('error', friendlyError(e)))}>
          <IconDownload /> Download
        </Button>
        <Button disabled={uploading} onClick={() => void doUpload(false)}>
          <IconUpload /> {rec.cloud ? 'In Google Drive' : 'Upload to Drive'}
        </Button>
        <Button disabled={uploading} onClick={() => void doUpload(true)}>
          <IconShare /> Share
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (!confirm('Delete this recording from this device? Files already uploaded to Google Drive are kept (delete them from the Gallery).')) return;
            void deleteCapture(rec.id).then(() => window.close());
          }}
        >
          <IconTrash /> Delete local copy
        </Button>
      </div>
      {share && <ShareDialog open fileId={share.id} filename={share.filename} onClose={() => setShare(null)} />}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[80vh] flex-col items-center justify-center gap-4 p-6">{children}</div>;
}

function RecorderPage() {
  const params = new URLSearchParams(location.search);
  const [action, setAction] = useState(params.get('action') ?? 'preview');
  const [previewId, setPreviewId] = useState(params.get('id') ?? '');
  const onDone = (id: string | null) => {
    if (!id) return setAction('empty');
    history.replaceState(null, '', `?action=preview&id=${encodeURIComponent(id)}`);
    setPreviewId(id);
    setAction('preview');
  };
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
        <Logo />
      </header>
      {action === 'screenshot' && <ScreenScreenshot split={params.get('split') === 'visible' || params.get('split') === 'region' ? (params.get('split') as 'visible' | 'region') : null} auto={params.get('auto') === '1'} />}
      {action === 'record' && <ScreenRecorder recordingId={params.get('rid') ?? ''} mic={params.get('mic') === '1'} audio={params.get('audio') === '1'} split={params.get('split') === '1'} onDone={onDone} />}
      {action === 'preview' && <VideoPreview id={previewId} />}
      {action === 'empty' && (
        <Centered>
          <EmptyState title="The recording contained no data." />
        </Centered>
      )}
    </div>
  );
}

mount(<RecorderPage />, 'SnapShare Recorder');
