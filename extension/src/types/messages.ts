export type CaptureMode = 'visible' | 'region' | 'fullpage' | 'screen';
export type RecordingMode = 'tab' | 'screen';

export interface RecordingOptions {
  mode: RecordingMode;
  microphone: boolean;
  /** Tab audio for tab mode; system/tab audio request for screen mode (availability decided by Chrome/OS). */
  systemAudio: boolean;
}

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error';

export interface RecordingState {
  phase: RecordingPhase;
  recordingId: string | null;
  mode: RecordingMode | null;
  /** Tab being recorded (tab mode). */
  targetTabId: number | null;
  /** Tab hosting the recorder page (screen mode). */
  ownerTabId: number | null;
  startedAt: number | null;
  pausedAt: number | null;
  pausedTotalMs: number;
  bytes: number;
  audio: { microphone: boolean; systemAudio: boolean };
  warnings: string[];
  error: string | null;
  lastCaptureId: string | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Messages handled by the background service worker. */
export type BackgroundRequest =
  | { type: 'capture'; mode: CaptureMode; tabId?: number }
  | { type: 'region:result'; rect: Rect | null; viewportWidth?: number; dpr?: number }
  | { type: 'screen:captured'; captureId: string }
  | { type: 'rec:start'; options: RecordingOptions }
  | { type: 'rec:pause' }
  | { type: 'rec:resume' }
  | { type: 'rec:stop' }
  | { type: 'rec:status' }
  | { type: 'rec:event'; event: RecorderEvent }
  | { type: 'open:editor'; captureId: string }
  | { type: 'open:page'; page: 'gallery' | 'settings' | 'permissions' };

/** Events emitted by recorder hosts (offscreen document / recorder page) to the background. */
export type RecorderEvent =
  | { kind: 'started'; recordingId: string; warnings: string[]; audio: { microphone: boolean; systemAudio: boolean } }
  | { kind: 'paused' }
  | { kind: 'resumed' }
  | { kind: 'progress'; bytes: number }
  | { kind: 'warning'; message: string }
  | { kind: 'stopped'; captureId: string | null; reason: string }
  | { kind: 'error'; message: string };

/** Commands sent from background to a recorder host. */
export type RecorderCommand =
  | { target: 'recorder'; type: 'start-tab'; streamId: string; recordingId: string; options: RecordingOptions; title: string }
  | { target: 'recorder'; type: 'pause' | 'resume' | 'stop'; recordingId: string };

export interface CaptureResult {
  ok: boolean;
  captureId?: string;
  error?: string;
}

export type BroadcastMessage =
  | { type: 'rec:state'; state: RecordingState }
  | { type: 'capture:progress'; label: string; progress: number };

/** Messages from background to the injected content script. */
export type ContentRequest =
  | { type: 'region:select' }
  | { type: 'page:metrics' }
  | { type: 'page:scrollTo'; y: number }
  | { type: 'page:prepare'; hideFixed: boolean }
  | { type: 'page:restore' }
  | { type: 'page:progress'; label: string; progress: number | null };

export interface PageMetrics {
  scrollHeight: number;
  scrollWidth: number;
  viewportHeight: number;
  viewportWidth: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}
