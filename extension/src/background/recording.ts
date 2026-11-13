import { platform } from '@/browser';
import { INITIAL_RECORDING_STATE, recordingReducer, elapsedMs, type RecordingAction } from '@/features/recording/state';
import { assembleRecording } from '@/features/recording/session';
import { listChunkRecordingIds, newId } from '@/services/db';
import { maybeAutoUpload } from './capture';
import type { RecorderCommand, RecorderEvent, RecordingOptions, RecordingState } from '@/types/messages';

const KEY = 'recState';
const OFFSCREEN = 'offscreen.html';
let cache: RecordingState | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Serialises state updates so concurrent events can't interleave read-modify-write. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function getRecordingState(): Promise<RecordingState> {
  if (cache) return cache;
  cache = (await platform.storage.session.get<RecordingState>(KEY)) ?? INITIAL_RECORDING_STATE;
  return cache;
}

async function commit(next: RecordingState) {
  cache = next;
  await platform.storage.session.set(KEY, next);
  const badge = next.phase === 'recording' ? 'REC' : next.phase === 'paused' ? '❚❚' : next.phase === 'error' ? '!' : '';
  await platform.setBadge(badge, next.phase === 'paused' ? '#d97706' : '#dc2626').catch(() => undefined);
  chrome.runtime.sendMessage({ type: 'rec:state', state: next }).catch(() => undefined);
}

async function dispatch(action: RecordingAction): Promise<RecordingState> {
  const next = recordingReducer(await getRecordingState(), action);
  await commit(next);
  return next;
}

async function sendToHost(cmd: RecorderCommand, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await chrome.runtime.sendMessage(cmd)) as { ok: boolean; error?: string } | undefined;
      if (res && !res.ok) throw new Error(res.error ?? 'Recorder failed');
      if (res) return;
    } catch (e) {
      if (!/Receiving end does not exist|Could not establish connection/.test(String((e as Error).message))) throw e;
    }
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
  }
  throw new Error('Recorder is not responding');
}

export function startRecording(options: RecordingOptions): Promise<RecordingState> {
  return serial(async () => {
    const state = await getRecordingState();
    if (state.phase === 'error') await dispatch({ type: 'RESET' });
    const recordingId = newId();
    if (options.mode === 'tab') {
      const tab = await platform.getActiveTab();
      if (!tab) throw new Error('No active tab to record');
      if (tab.url && /^(chrome|edge|about|devtools|chrome-extension):/.test(tab.url)) throw new Error('Chrome does not allow recording browser internal pages.');
      // getMediaStreamId must be called while the extension is invoked on the tab (popup click / shortcut).
      const streamId = await platform.getTabMediaStreamId(tab.id);
      await dispatch({ type: 'START_REQUESTED', mode: 'tab', recordingId, targetTabId: tab.id });
      try {
        await platform.ensureOffscreen(OFFSCREEN, ['USER_MEDIA', 'AUDIO_PLAYBACK'], 'Record the current tab and play back its audio while recording continues after the popup closes.');
        await sendToHost({ target: 'recorder', type: 'start-tab', streamId, recordingId, options, title: tab.title ?? '' });
      } catch (e) {
        await dispatch({ type: 'ERROR', message: (e as Error).message });
        await platform.closeOffscreen();
        throw e;
      }
    } else {
      const q = new URLSearchParams({ action: 'record', rid: recordingId, mic: options.microphone ? '1' : '0', audio: options.systemAudio ? '1' : '0' });
      const tab = await platform.openExtensionPage(`recorder.html?${q}`);
      await dispatch({ type: 'START_REQUESTED', mode: 'screen', recordingId, ownerTabId: tab.id });
    }
    return getRecordingState();
  });
}

async function command(type: 'pause' | 'resume' | 'stop') {
  const s = await getRecordingState();
  if (!s.recordingId) throw new Error('No recording in progress');
  if (type === 'stop') {
    if (s.phase === 'starting') {
      // User gave up before picking a source.
      if (s.ownerTabId) await platform.closeTab(s.ownerTabId);
      await dispatch({ type: 'RESET' });
      return;
    }
    await dispatch({ type: 'STOP_REQUESTED' });
  }
  try {
    await sendToHost({ target: 'recorder', type, recordingId: s.recordingId }, 2);
  } catch (e) {
    if (type === 'stop') await recoverCurrent('Recorder stopped responding');
    else throw e;
  }
}

export const pauseRecording = () => serial(() => command('pause'));
export const resumeRecording = () => serial(() => command('resume'));
export const stopRecording = () => serial(() => command('stop'));

export function handleRecorderEvent(event: RecorderEvent): Promise<void> {
  return serial(async () => {
    const s = await getRecordingState();
    const now = Date.now();
    try {
      switch (event.kind) {
        case 'started':
          await dispatch({ type: 'STARTED', recordingId: event.recordingId, at: now, audio: event.audio, warnings: event.warnings });
          break;
        case 'paused':
          await dispatch({ type: 'PAUSED', at: now });
          break;
        case 'resumed':
          await dispatch({ type: 'RESUMED', at: now });
          break;
        case 'progress':
          await dispatch({ type: 'PROGRESS', bytes: event.bytes });
          break;
        case 'warning':
          await dispatch({ type: 'WARNING', message: event.message });
          break;
        case 'stopped': {
          const wasTab = s.mode === 'tab';
          await dispatch({ type: 'STOPPED', captureId: event.captureId });
          if (event.captureId) void maybeAutoUpload(event.captureId);
          if (wasTab) {
            await platform.closeOffscreen();
            if (event.captureId) await platform.openExtensionPage(`recorder.html?action=preview&id=${encodeURIComponent(event.captureId)}`);
          }
          break;
        }
        case 'error':
          await dispatch({ type: 'ERROR', message: event.message });
          if (s.mode === 'tab') await platform.closeOffscreen();
          break;
      }
    } catch {
      /* stale event for a state we've already left — ignore */
    }
  });
}

/** Salvages persisted chunks when the recording host disappeared (crash, closed tab, SW restart). */
async function recoverCurrent(reason: string) {
  const s = await getRecordingState();
  if (!s.recordingId) return;
  const id = await assembleRecording(s.recordingId, { durationMs: elapsedMs(s, Date.now()), recovered: true }).catch(() => null);
  await commit({ ...INITIAL_RECORDING_STATE, lastCaptureId: id ?? s.lastCaptureId, warnings: [`${reason}. ${id ? 'The recording was recovered.' : 'No data could be recovered.'}`] });
  await platform.closeOffscreen();
  if (id) await platform.openExtensionPage(`recorder.html?action=preview&id=${encodeURIComponent(id)}`);
}

export function onTabRemoved(tabId: number) {
  return serial(async () => {
    const s = await getRecordingState();
    if (s.phase === 'idle' || s.phase === 'error') return;
    if (s.mode === 'tab' && s.targetTabId === tabId && s.recordingId) {
      // The capture track will end on its own; ask the host to finalise in case it doesn't.
      if (s.phase !== 'stopping') await dispatch({ type: 'STOP_REQUESTED' }).catch(() => undefined);
      await sendToHost({ target: 'recorder', type: 'stop', recordingId: s.recordingId }, 2).catch(() => recoverCurrent('The recorded tab was closed'));
    }
    if (s.mode === 'screen' && s.ownerTabId === tabId) {
      if (s.phase === 'starting') await dispatch({ type: 'RESET' });
      else await recoverCurrent('The recorder tab was closed');
    }
  });
}

/** Run on service-worker start: reconcile persisted state with what's actually alive. */
export function reconcileOnStartup() {
  return serial(async () => {
    const s = await getRecordingState();
    if (s.phase === 'idle' || s.phase === 'error') {
      // Orphaned chunks from a crash/browser restart.
      for (const rid of await listChunkRecordingIds()) {
        if (rid !== s.recordingId) await assembleRecording(rid, { durationMs: null, recovered: true }).catch(() => undefined);
      }
      return;
    }
    const alive = s.mode === 'tab' ? await platform.hasOffscreen(OFFSCREEN) : s.ownerTabId !== null && (await platform.getTab(s.ownerTabId)) !== null;
    if (!alive) await recoverCurrent('Recording was interrupted');
  });
}
