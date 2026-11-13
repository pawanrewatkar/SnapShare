import type { RecordingMode } from '@/types/messages';

export type OsFamily = 'windows' | 'mac' | 'linux' | 'chromeos' | 'other';

export function detectOs(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): OsFamily {
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

export interface AudioPlan {
  /** Ask Chrome for tab audio (tab mode) or display audio (screen mode). */
  requestSystemAudio: boolean;
  requestMicrophone: boolean;
  /** User-facing notes on what Chrome can actually deliver. */
  notes: string[];
}

/**
 * Decides which audio sources to request. Chrome support matrix (documented limitations):
 *  - Tab recording (tabCapture): tab audio on all desktop OSes. Microphone via getUserMedia.
 *  - Screen/window via getDisplayMedia: whole-screen system audio on Windows and ChromeOS only;
 *    sharing a *tab* from the picker includes tab audio on all OSes; window audio is generally not available;
 *    macOS/Linux cannot share whole-screen system audio.
 */
export function planAudio(mode: RecordingMode, wantSystem: boolean, wantMic: boolean, os: OsFamily): AudioPlan {
  const notes: string[] = [];
  if (mode === 'tab') {
    return { requestSystemAudio: wantSystem, requestMicrophone: wantMic, notes };
  }
  if (wantSystem) {
    if (os === 'windows' || os === 'chromeos') notes.push('Tick "Share system audio" (screen) or "Share tab audio" (tab) in Chrome’s picker to include sound. Window sharing has no audio.');
    else notes.push('On this OS Chrome can only include audio when you share a browser tab. Screen and window sharing will be silent.');
  }
  return { requestSystemAudio: wantSystem, requestMicrophone: wantMic, notes };
}

/** After the stream is obtained, explain any requested audio that Chrome did not deliver. */
export function audioWarnings(plan: AudioPlan, got: { system: boolean; mic: boolean; micError?: string | null }): string[] {
  const w: string[] = [];
  if (plan.requestSystemAudio && !got.system) w.push('System/tab audio is not included: it was not shared or is unsupported for this source on your OS.');
  if (plan.requestMicrophone && !got.mic) w.push(`Microphone is not recorded${got.micError ? `: ${got.micError}` : '.'}`);
  return w;
}

export function micErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'microphone permission was denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no microphone was found';
  if (name === 'NotReadableError') return 'the microphone is in use by another application';
  return (e as Error)?.message || 'microphone unavailable';
}

export function pickMimeType(isSupported: (t: string) => boolean = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)): string {
  for (const t of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    if (isSupported(t)) return t;
  }
  return 'video/webm';
}
