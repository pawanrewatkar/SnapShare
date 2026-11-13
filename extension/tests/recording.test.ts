import { describe, expect, it } from 'vitest';
import { elapsedMs, INITIAL_RECORDING_STATE, InvalidTransitionError, isActive, recordingReducer } from '@/features/recording/state';
import { audioWarnings, detectOs, micErrorMessage, pickMimeType, planAudio } from '@/features/recording/audio';

const start = () => recordingReducer(INITIAL_RECORDING_STATE, { type: 'START_REQUESTED', mode: 'tab', recordingId: 'r1', targetTabId: 7 });

describe('recording state machine', () => {
  it('runs start → pause → resume → stop', () => {
    let s = start();
    expect(s.phase).toBe('starting');
    s = recordingReducer(s, { type: 'STARTED', recordingId: 'r1', at: 1000, audio: { microphone: true, systemAudio: true }, warnings: [] });
    expect(s.phase).toBe('recording');
    s = recordingReducer(s, { type: 'PAUSED', at: 5000 });
    expect(elapsedMs(s, 99_999)).toBe(4000); // frozen while paused
    s = recordingReducer(s, { type: 'RESUMED', at: 8000 });
    expect(s.pausedTotalMs).toBe(3000);
    expect(elapsedMs(s, 10_000)).toBe(6000);
    s = recordingReducer(s, { type: 'STOP_REQUESTED' });
    expect(s.phase).toBe('stopping');
    expect(isActive(s)).toBe(true);
    s = recordingReducer(s, { type: 'STOPPED', captureId: 'cap' });
    expect(s.phase).toBe('idle');
    expect(s.lastCaptureId).toBe('cap');
    expect(isActive(s)).toBe(false);
  });
  it('rejects starting twice', () => {
    expect(() => recordingReducer(start(), { type: 'START_REQUESTED', mode: 'screen', recordingId: 'r2' })).toThrow(InvalidTransitionError);
  });
  it('rejects pause when not recording and resume when not paused', () => {
    expect(() => recordingReducer(start(), { type: 'PAUSED', at: 1 })).toThrow(InvalidTransitionError);
    expect(() => recordingReducer(INITIAL_RECORDING_STATE, { type: 'RESUMED', at: 1 })).toThrow(InvalidTransitionError);
  });
  it('ignores a STARTED event for a different recording', () => {
    expect(() => recordingReducer(start(), { type: 'STARTED', recordingId: 'other', at: 1, audio: { microphone: false, systemAudio: false }, warnings: [] })).toThrow();
  });
  it('error state allows a fresh start and keeps the last capture', () => {
    let s = recordingReducer({ ...INITIAL_RECORDING_STATE, lastCaptureId: 'old' }, { type: 'ERROR', message: 'Permission denied' });
    expect(s.phase).toBe('error');
    expect(s.lastCaptureId).toBe('old');
    s = recordingReducer(s, { type: 'START_REQUESTED', mode: 'tab', recordingId: 'r3' });
    expect(s.phase).toBe('starting');
  });
  it('deduplicates warnings', () => {
    let s = start();
    s = recordingReducer(s, { type: 'WARNING', message: 'mic lost' });
    s = recordingReducer(s, { type: 'WARNING', message: 'mic lost' });
    expect(s.warnings).toEqual(['mic lost']);
  });
});

describe('audio support matrix', () => {
  it('detects OS families', () => {
    expect(detectOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(detectOs('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)')).toBe('chromeos');
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });
  it('tab mode supports tab audio + mic on every OS without caveats', () => {
    expect(planAudio('tab', true, true, 'mac')).toEqual({ requestSystemAudio: true, requestMicrophone: true, notes: [] });
  });
  it('explains that macOS/Linux cannot capture whole-screen system audio', () => {
    const p = planAudio('screen', true, false, 'mac');
    expect(p.notes.join(' ')).toMatch(/only include audio when you share a browser tab/);
    expect(planAudio('screen', true, false, 'windows').notes.join(' ')).toMatch(/Share system audio/);
  });
  it('warns when a requested audio source was not delivered (unsupported combination)', () => {
    const plan = planAudio('screen', true, true, 'linux');
    const w = audioWarnings(plan, { system: false, mic: false, micError: 'microphone permission was denied' });
    expect(w).toHaveLength(2);
    expect(w[1]).toMatch(/permission was denied/);
    expect(audioWarnings(plan, { system: true, mic: true })).toEqual([]);
  });
  it('maps microphone permission errors', () => {
    expect(micErrorMessage({ name: 'NotAllowedError' })).toMatch(/denied/);
    expect(micErrorMessage({ name: 'NotFoundError' })).toMatch(/no microphone/);
    expect(micErrorMessage({ name: 'NotReadableError' })).toMatch(/in use/);
  });
  it('picks the best supported WebM codec', () => {
    expect(pickMimeType((t) => t === 'video/webm;codecs=vp8,opus')).toBe('video/webm;codecs=vp8,opus');
    expect(pickMimeType(() => false)).toBe('video/webm');
  });
});
