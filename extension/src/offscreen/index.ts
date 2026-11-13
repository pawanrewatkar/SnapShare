/**
 * Offscreen document: owns tab recordings so they survive the popup closing.
 * Receives a tabCapture stream id from the service worker and runs a RecorderSession.
 */
import { RecorderSession } from '@/features/recording/session';
import { audioWarnings, micErrorMessage, planAudio, detectOs } from '@/features/recording/audio';
import type { RecorderCommand, RecorderEvent } from '@/types/messages';

let session: RecorderSession | null = null;
let currentId: string | null = null;

const emit = (event: RecorderEvent) => chrome.runtime.sendMessage({ type: 'rec:event', event }).catch(() => undefined);

async function startTab(cmd: Extract<RecorderCommand, { type: 'start-tab' }>) {
  if (session) throw new Error('A recording is already running');
  const plan = planAudio('tab', cmd.options.systemAudio, cmd.options.microphone, detectOs());
  const tabConstraint = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: cmd.streamId } };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: plan.requestSystemAudio ? (tabConstraint as unknown as MediaTrackConstraints) : false,
    video: { mandatory: { ...tabConstraint.mandatory, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 30 } } as unknown as MediaTrackConstraints,
  });
  let mic: MediaStream | null = null;
  let micError: string | null = null;
  if (plan.requestMicrophone) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      micError = micErrorMessage(e) + ' (grant access on the SnapShare permissions page)';
    }
  }
  const sourceAudio = stream.getAudioTracks()[0] ?? null;
  currentId = cmd.recordingId;
  session = new RecorderSession({
    recordingId: cmd.recordingId,
    video: new MediaStream(stream.getVideoTracks()),
    sourceAudio,
    mic,
    playbackSourceAudio: true,
    title: cmd.title,
    onEvent: (e) => {
      if (e.kind === 'stopped' || (e.kind === 'error' && !session)) {
        session = null;
        currentId = null;
      }
      void emit(e);
    },
  });
  const { audio } = session.start();
  const warnings = audioWarnings(plan, { system: audio.systemAudio, mic: audio.microphone, micError });
  void emit({ kind: 'started', recordingId: cmd.recordingId, warnings, audio });
}

chrome.runtime.onMessage.addListener((msg: RecorderCommand, _sender, sendResponse) => {
  if (msg?.target !== 'recorder') return;
  if (msg.type !== 'start-tab' && msg.recordingId !== currentId) return; // command for another host
  (async () => {
    switch (msg.type) {
      case 'start-tab':
        await startTab(msg);
        break;
      case 'pause':
        session?.pause();
        break;
      case 'resume':
        session?.resume();
        break;
      case 'stop':
        await session?.stop('user');
        break;
    }
    return { ok: true };
  })().then(sendResponse, (e) => {
    session = null;
    currentId = null;
    const message = (e as DOMException)?.name === 'NotAllowedError' ? 'Chrome denied tab capture permission.' : (e as Error).message;
    void emit({ kind: 'error', message });
    sendResponse({ ok: false, error: message });
  });
  return true;
});
