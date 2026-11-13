import { useEffect, useState, type ReactElement } from 'react';
import { formatBytes, formatDuration } from '@snapshare/shared';
import { mount } from './mount';
import { Button, IconButton, Logo, Spinner, useToast } from '@/components/ui';
import { IconCamera, IconGallery, IconMonitor, IconPage, IconPause, IconPlay, IconRegion, IconSettings, IconStop, IconVideo } from '@/components/icons';
import { useNow, useObjectUrl, useRecordingState, useSession, useSettings } from '@/hooks';
import { sendBg } from '@/services/messaging';
import { getCapture, listCaptures, type CaptureMeta } from '@/services/db';
import { signIn } from '@/features/authentication/auth';
import { friendlyError } from '@/services/api';
import { elapsedMs, isActive } from '@/features/recording/state';
import type { CaptureMode, CaptureResult, RecordingMode } from '@/types/messages';

async function micPermission(): Promise<PermissionState | 'unknown'> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return 'unknown';
  }
}

function Thumb({ meta }: { meta: CaptureMeta }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    if (meta.kind !== 'video') void getCapture(meta.id).then((c) => setBlob(c?.blob ?? null));
  }, [meta.id, meta.kind]);
  const url = useObjectUrl(blob);
  const open = () =>
    meta.kind === 'video'
      ? chrome.tabs.create({ url: chrome.runtime.getURL(`recorder.html?action=preview&id=${meta.id}`) })
      : sendBg({ type: 'open:editor', captureId: meta.id });
  return (
    <button onClick={() => void open()} className="focus-ring group relative aspect-video overflow-hidden rounded-md border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800" title={meta.filename}>
      {meta.kind === 'video' ? (
        <span className="flex h-full items-center justify-center text-slate-500">
          <IconVideo />
        </span>
      ) : url ? (
        <img src={url} alt={meta.filename} className="h-full w-full object-cover object-top" />
      ) : null}
      <span className="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-1 text-[10px] text-white">{meta.kind === 'edited' ? 'Edited' : meta.kind === 'video' ? 'Video' : 'Screenshot'}</span>
    </button>
  );
}

function Popup() {
  const toast = useToast();
  const { session, loading } = useSession();
  const { settings, update } = useSettings();
  const rec = useRecordingState();
  const active = isActive(rec);
  const now = useNow(rec.phase === 'recording');
  const [busy, setBusy] = useState<string | null>(null);
  const [recent, setRecent] = useState<CaptureMeta[]>([]);
  const [recMode, setRecMode] = useState<RecordingMode>('tab');

  useEffect(() => {
    void listCaptures(4).then(setRecent);
  }, [rec.lastCaptureId]);

  const capture = async (mode: CaptureMode) => {
    setBusy(mode);
    try {
      // The service worker owns the capture; the editor (or region overlay / screen picker) opens on its own.
      const r = await sendBg<CaptureResult>({ type: 'capture', mode });
      if (!r.ok) throw new Error(r.error);
      window.close();
    } catch (e) {
      toast('error', friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const startRec = async () => {
    if (!settings) return;
    setBusy('rec');
    try {
      if (recMode === 'tab' && settings.recordMicrophone) {
        const perm = await micPermission();
        if (perm !== 'granted') {
          await chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html?for=microphone') });
          toast('info', 'Allow microphone access in the tab that opened, then start recording again.');
          return;
        }
      }
      await sendBg({ type: 'rec:start', options: { mode: recMode, microphone: settings.recordMicrophone, systemAudio: settings.recordSystemAudio } });
      if (recMode === 'screen') window.close();
    } catch (e) {
      toast('error', friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const recCmd = async (type: 'rec:pause' | 'rec:resume' | 'rec:stop') => {
    try {
      await sendBg({ type });
    } catch (e) {
      toast('error', friendlyError(e));
    }
  };

  const doSignIn = async () => {
    setBusy('auth');
    try {
      await signIn();
      toast('success', 'Signed in to Google');
    } catch (e) {
      toast('error', friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const modes: { mode: CaptureMode; label: string; icon: ReactElement; hint: string }[] = [
    { mode: 'visible', label: 'Visible area', icon: <IconCamera />, hint: 'Alt+Shift+V' },
    { mode: 'region', label: 'Select region', icon: <IconRegion />, hint: 'Alt+Shift+R' },
    { mode: 'fullpage', label: 'Full page', icon: <IconPage />, hint: 'Alt+Shift+F' },
    { mode: 'screen', label: 'Screen / window', icon: <IconMonitor />, hint: 'Pick in Chrome' },
  ];

  return (
    <div className="w-[360px] p-4 text-sm">
      <header className="mb-4 flex items-center justify-between">
        <Logo />
        {loading ? (
          <Spinner />
        ) : session ? (
          <button className="focus-ring flex items-center gap-2 rounded-full" title={session.user.email} onClick={() => void sendBg({ type: 'open:page', page: 'settings' })}>
            {session.user.avatarUrl ? <img src={session.user.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-7 w-7 rounded-full" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-white">{session.user.email[0]?.toUpperCase()}</span>}
            <span className="max-w-[120px] truncate text-xs text-slate-600 dark:text-slate-300">{session.user.name ?? session.user.email}</span>
          </button>
        ) : (
          <Button size="sm" variant="primary" loading={busy === 'auth'} onClick={() => void doSignIn()}>
            Sign in with Google
          </Button>
        )}
      </header>

      <section aria-label="Screenshot" className="mb-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Screenshot</h2>
        <div className="grid grid-cols-2 gap-2">
          {modes.map((m) => (
            <button
              key={m.mode}
              disabled={!!busy || active}
              onClick={() => void capture(m.mode)}
              className="focus-ring flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-left hover:border-brand-500 hover:bg-brand-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              <span className="text-brand-600">{busy === m.mode ? <Spinner /> : m.icon}</span>
              <span>
                <span className="block font-medium">{m.label}</span>
                <span className="block text-[11px] text-slate-500">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Recording" className="mb-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Screen recording</h2>
        {active ? (
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 font-mono text-lg">
                <span className={`h-2.5 w-2.5 rounded-full ${rec.phase === 'recording' ? 'animate-pulse bg-red-600' : 'bg-amber-500'}`} />
                {formatDuration(elapsedMs(rec, now))}
              </div>
              <div className="text-xs text-slate-500">
                {rec.phase === 'starting' ? 'Waiting for source selection…' : rec.phase === 'stopping' ? 'Saving…' : `${rec.mode === 'tab' ? 'Tab' : 'Screen'} · ${rec.phase} · ${formatBytes(rec.bytes)}`}
              </div>
            </div>
            <div className="flex gap-1">
              {rec.phase === 'recording' && (
                <IconButton label="Pause" onClick={() => void recCmd('rec:pause')}>
                  <IconPause />
                </IconButton>
              )}
              {rec.phase === 'paused' && (
                <IconButton label="Resume" onClick={() => void recCmd('rec:resume')}>
                  <IconPlay />
                </IconButton>
              )}
              <IconButton label={rec.phase === 'starting' ? 'Cancel' : 'Stop'} className="text-red-600" disabled={rec.phase === 'stopping'} onClick={() => void recCmd('rec:stop')}>
                <IconStop />
              </IconButton>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-2 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800" role="radiogroup" aria-label="Recording source">
              {(['tab', 'screen'] as const).map((m) => (
                <button key={m} role="radio" aria-checked={recMode === m} onClick={() => setRecMode(m)} className={`rounded-md py-1.5 text-xs font-medium ${recMode === m ? 'bg-white shadow dark:bg-slate-700' : 'text-slate-600 dark:text-slate-300'}`}>
                  {m === 'tab' ? 'This tab' : 'Screen / window'}
                </button>
              ))}
            </div>
            {settings && (
              <div className="mb-2 flex flex-col gap-1 text-xs">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settings.recordSystemAudio} onChange={(e) => void update({ recordSystemAudio: e.target.checked })} />
                  {recMode === 'tab' ? 'Tab audio' : 'System / tab audio (where Chrome supports it)'}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={settings.recordMicrophone} onChange={(e) => void update({ recordMicrophone: e.target.checked })} />
                  Microphone
                </label>
              </div>
            )}
            {rec.phase === 'error' && rec.error && <p className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{rec.error}</p>}
            {rec.warnings.length > 0 && <p className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">{rec.warnings.join(' ')}</p>}
            <Button variant="primary" className="w-full" loading={busy === 'rec'} disabled={!!busy} onClick={() => void startRec()}>
              <IconVideo /> Start recording
            </Button>
          </>
        )}
      </section>

      <section aria-label="Recent captures" className="mb-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent</h2>
        {recent.length === 0 ? (
          <p className="text-xs text-slate-500">No captures yet.</p>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {recent.map((m) => (
              <Thumb key={m.id} meta={m} />
            ))}
          </div>
        )}
      </section>

      <footer className="flex gap-2">
        <Button className="flex-1" onClick={() => void sendBg({ type: 'open:page', page: 'gallery' })}>
          <IconGallery /> Gallery
        </Button>
        <Button className="flex-1" onClick={() => void sendBg({ type: 'open:page', page: 'settings' })}>
          <IconSettings /> Settings
        </Button>
      </footer>
    </div>
  );
}

mount(<Popup />, 'SnapShare');
