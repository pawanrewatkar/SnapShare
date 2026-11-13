import fixWebmDuration from 'fix-webm-duration';
import { appendChunk, deleteChunks, getChunks, putCapture } from '@/services/db';
import { buildFilename, getSettings } from '@/services/settings';
import type { RecorderEvent } from '@/types/messages';
import { pickMimeType } from './audio';

/** Patching duration metadata needs the whole file in memory; skip for very large recordings. */
const MAX_DURATION_FIX_BYTES = 512 * 1024 * 1024;

/** Builds a video capture from persisted chunks and removes the chunks. Used for normal stop and crash recovery. */
export async function assembleRecording(recordingId: string, opts: { durationMs: number | null; title?: string | null; recovered?: boolean }): Promise<string | null> {
  const chunks = await getChunks(recordingId);
  if (chunks.length === 0) {
    await deleteChunks(recordingId);
    return null;
  }
  let blob = new Blob(chunks, { type: 'video/webm' });
  if (opts.durationMs && opts.durationMs > 0 && blob.size <= MAX_DURATION_FIX_BYTES) {
    try {
      blob = await fixWebmDuration(blob, opts.durationMs, { logger: false });
    } catch {
      /* keep unpatched file */
    }
  }
  const settings = await getSettings();
  const id = recordingId;
  await putCapture({
    id,
    kind: 'video',
    blob,
    mimeType: 'video/webm',
    filename: buildFilename(settings.filenamePattern, { title: opts.title, kind: 'recording' }) + (opts.recovered ? ' (recovered)' : ''),
    size: blob.size,
    width: null,
    height: null,
    durationMs: opts.durationMs,
    createdAt: Date.now(),
    parentId: null,
    sourceUrl: null,
    sourceTitle: opts.title ?? null,
    cloud: null,
    recovered: opts.recovered,
  });
  await deleteChunks(recordingId);
  return id;
}

export interface SessionInput {
  recordingId: string;
  video: MediaStream;
  /** Audio from the captured source (tab audio or shared system/tab audio). */
  sourceAudio: MediaStreamTrack | null;
  mic: MediaStream | null;
  /** Route source audio back to speakers (tab capture mutes the tab otherwise). */
  playbackSourceAudio: boolean;
  title: string | null;
  onEvent: (e: RecorderEvent) => void;
}

/**
 * Owns the MediaRecorder lifecycle independently of any UI. Chunks are persisted to IndexedDB every second
 * so large recordings don't sit in memory and an interrupted recording can be recovered.
 */
export class RecorderSession {
  private recorder: MediaRecorder | null = null;
  private audioCtx: AudioContext | null = null;
  private seq = 0;
  private bytes = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private stopReason = 'user';
  private stopped = false;
  private lastProgress = 0;

  constructor(private input: SessionInput) {}

  start(): { audio: { microphone: boolean; systemAudio: boolean } } {
    const { video, sourceAudio, mic, playbackSourceAudio } = this.input;
    const videoTrack = video.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track was captured');
    const tracks: MediaStreamTrack[] = [videoTrack];
    const micTrack = mic?.getAudioTracks()[0] ?? null;
    if (sourceAudio || micTrack) {
      this.audioCtx = new AudioContext();
      const dest = this.audioCtx.createMediaStreamDestination();
      if (sourceAudio) {
        const src = this.audioCtx.createMediaStreamSource(new MediaStream([sourceAudio]));
        src.connect(dest);
        if (playbackSourceAudio) src.connect(this.audioCtx.destination);
      }
      if (micTrack) this.audioCtx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
    this.recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const seq = this.seq++;
      this.bytes += ev.data.size;
      this.writeChain = this.writeChain
        .then(() => appendChunk(this.input.recordingId, seq, ev.data))
        .catch((e) => {
          this.input.onEvent({ kind: 'warning', message: `Could not save recording data: ${(e as Error).message}` });
        });
      const now = Date.now();
      if (now - this.lastProgress > 900) {
        this.lastProgress = now;
        this.input.onEvent({ kind: 'progress', bytes: this.bytes });
      }
    };
    this.recorder.onerror = (ev) => {
      const err = (ev as unknown as { error?: Error }).error;
      this.input.onEvent({ kind: 'error', message: `Recorder error: ${err?.message ?? 'unknown'}` });
      void this.stop('recorder-error');
    };
    this.recorder.onstop = () => void this.finalize();

    videoTrack.addEventListener('ended', () => void this.stop('source-ended'));
    sourceAudio?.addEventListener('ended', () => this.input.onEvent({ kind: 'warning', message: 'Captured audio stopped; recording continues without it.' }));
    micTrack?.addEventListener('ended', () => this.input.onEvent({ kind: 'warning', message: 'Microphone was disconnected; recording continues without it.' }));

    this.recorder.start(1000);
    this.startedAt = Date.now();
    return { audio: { microphone: !!micTrack, systemAudio: !!sourceAudio } };
  }

  pause() {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.pausedAt = Date.now();
      this.input.onEvent({ kind: 'paused' });
    }
  }

  resume() {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      if (this.pausedAt) this.pausedTotal += Date.now() - this.pausedAt;
      this.pausedAt = null;
      this.input.onEvent({ kind: 'resumed' });
    }
  }

  async stop(reason = 'user') {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else await this.finalize();
  }

  get durationMs(): number {
    if (!this.startedAt) return 0;
    const end = this.pausedAt ?? Date.now();
    return end - this.startedAt - this.pausedTotal;
  }

  private releaseMedia() {
    for (const s of [this.input.video, this.input.mic]) s?.getTracks().forEach((t) => t.stop());
    this.input.sourceAudio?.stop();
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
  }

  private finalized = false;
  private async finalize() {
    if (this.finalized) return;
    this.finalized = true;
    const duration = this.durationMs;
    this.releaseMedia();
    try {
      await this.writeChain;
      const captureId = await assembleRecording(this.input.recordingId, { durationMs: duration, title: this.input.title });
      this.input.onEvent({ kind: 'stopped', captureId, reason: this.stopReason });
    } catch (e) {
      this.input.onEvent({ kind: 'error', message: `Could not save the recording: ${(e as Error).message}` });
    }
  }
}
