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
function ScreenScreenshot() {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    setBusy(true);
    setErr(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 300)); // let the first real frame arrive
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')!.drawImage(video, 0, 0);
      const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), 'image/png'));
      const settings = await getSettings();
      const id = newId();
      await putCapture({
        id,
        kind: 'screenshot',
        blob,
        mimeType: 'image/png',
        filename: buildFilename(settings.filenamePattern, { title: 'Screen', kind: 'screenshot' }),
        size: blob.size,
        width: canvas.width,
        height: canvas.height,
        durationMs: null,
        createdAt: Date.now(),
        parentId: null,
        sourceUrl: null,
        sourceTitle: 'Screen capture',
        cloud: null,
      });
      location.replace(`editor.html?id=${encodeURIComponent(id)}`);
    } catch (e) {
      setErr(displayMediaError(e));
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setBusy(false);
    }
  };
  return (
    <Centered>
      <IconMonitor width={40} height={40} className="text-brand-600" />
      <h1 className="text-xl font-semibold">Capture your screen or a window</h1>
      <p className="max-w-md text-center text-sm text-slate-500">Chrome will ask which screen, window or tab to capture. SnapShare grabs a single still image and stops sharing immediately.</p>
      {err && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{err}</p>}
      <Button variant="primary" loading={busy} onClick={() => void pick()}>
        Choose screen or window
      </Button>
    </Centered>
  );
}

/* ---------------- Screen recording host ---------------- */
function ScreenRecorder({ recordingId, mic, audio, onDone }: { recordingId: string; mic: boolean; audio: boolean; onDone: (id: string | null) => void }) {
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
      {action === 'screenshot' && <ScreenScreenshot />}
      {action === 'record' && <ScreenRecorder recordingId={params.get('rid') ?? ''} mic={params.get('mic') === '1'} audio={params.get('audio') === '1'} onDone={onDone} />}
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
