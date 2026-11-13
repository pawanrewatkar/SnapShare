import type { RecordingMode, RecordingState } from '@/types/messages';

export const INITIAL_RECORDING_STATE: RecordingState = {
  phase: 'idle',
  recordingId: null,
  mode: null,
  targetTabId: null,
  ownerTabId: null,
  startedAt: null,
  pausedAt: null,
  pausedTotalMs: 0,
  bytes: 0,
  audio: { microphone: false, systemAudio: false },
  warnings: [],
  error: null,
  lastCaptureId: null,
};

export type RecordingAction =
  | { type: 'START_REQUESTED'; mode: RecordingMode; recordingId: string; targetTabId?: number | null; ownerTabId?: number | null }
  | { type: 'STARTED'; recordingId: string; at: number; audio: { microphone: boolean; systemAudio: boolean }; warnings: string[] }
  | { type: 'PAUSED'; at: number }
  | { type: 'RESUMED'; at: number }
  | { type: 'PROGRESS'; bytes: number }
  | { type: 'WARNING'; message: string }
  | { type: 'STOP_REQUESTED' }
  | { type: 'STOPPED'; captureId: string | null }
  | { type: 'ERROR'; message: string }
  | { type: 'RESET' };

export class InvalidTransitionError extends Error {}

/** Pure recording state machine. Invalid transitions throw so callers can surface a precise error. */
export function recordingReducer(state: RecordingState, action: RecordingAction): RecordingState {
  switch (action.type) {
    case 'START_REQUESTED':
      if (state.phase !== 'idle' && state.phase !== 'error') throw new InvalidTransitionError('A recording is already in progress');
      return {
        ...INITIAL_RECORDING_STATE,
        phase: 'starting',
        mode: action.mode,
        recordingId: action.recordingId,
        targetTabId: action.targetTabId ?? null,
        ownerTabId: action.ownerTabId ?? null,
        lastCaptureId: state.lastCaptureId,
      };
    case 'STARTED':
      if (state.phase !== 'starting' || state.recordingId !== action.recordingId) throw new InvalidTransitionError('Recording was not starting');
      return { ...state, phase: 'recording', startedAt: action.at, audio: action.audio, warnings: action.warnings };
    case 'PAUSED':
      if (state.phase !== 'recording') throw new InvalidTransitionError('Not recording');
      return { ...state, phase: 'paused', pausedAt: action.at };
    case 'RESUMED':
      if (state.phase !== 'paused') throw new InvalidTransitionError('Not paused');
      return { ...state, phase: 'recording', pausedTotalMs: state.pausedTotalMs + (action.at - (state.pausedAt ?? action.at)), pausedAt: null };
    case 'PROGRESS':
      return { ...state, bytes: action.bytes };
    case 'WARNING':
      return state.warnings.includes(action.message) ? state : { ...state, warnings: [...state.warnings, action.message] };
    case 'STOP_REQUESTED':
      if (state.phase !== 'recording' && state.phase !== 'paused' && state.phase !== 'starting') throw new InvalidTransitionError('Nothing to stop');
      return { ...state, phase: 'stopping' };
    case 'STOPPED':
      return { ...INITIAL_RECORDING_STATE, lastCaptureId: action.captureId ?? state.lastCaptureId, warnings: state.warnings };
    case 'ERROR':
      return { ...INITIAL_RECORDING_STATE, phase: 'error', error: action.message, lastCaptureId: state.lastCaptureId };
    case 'RESET':
      return { ...INITIAL_RECORDING_STATE, lastCaptureId: state.lastCaptureId };
  }
}

/** Active (non-paused) recording time in ms. */
export function elapsedMs(state: Pick<RecordingState, 'startedAt' | 'pausedAt' | 'pausedTotalMs'>, now: number): number {
  if (!state.startedAt) return 0;
  const end = state.pausedAt ?? now;
  return Math.max(0, end - state.startedAt - state.pausedTotalMs);
}

export function isActive(state: RecordingState): boolean {
  return state.phase === 'starting' || state.phase === 'recording' || state.phase === 'paused' || state.phase === 'stopping';
}
