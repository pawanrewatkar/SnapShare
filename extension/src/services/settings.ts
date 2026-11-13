import { platform } from '@/browser';
import type { CaptureMode } from '@/types/messages';

export interface Settings {
  defaultCaptureMode: CaptureMode;
  openEditorAfterCapture: boolean;
  hideFixedElementsOnFullPage: boolean;
  downloadSubfolder: string;
  askWhereToSave: boolean;
  filenamePattern: string;
  autoUploadToDrive: boolean;
  defaultShareAccess: 'restricted' | 'public';
  defaultShareExpiryDays: number;
  shareAllowDownload: boolean;
  recordMicrophone: boolean;
  recordSystemAudio: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultCaptureMode: 'visible',
  openEditorAfterCapture: true,
  hideFixedElementsOnFullPage: true,
  downloadSubfolder: 'SnapShare',
  askWhereToSave: false,
  filenamePattern: 'SnapShare {date} {time}',
  autoUploadToDrive: false,
  defaultShareAccess: 'restricted',
  defaultShareExpiryDays: 7,
  shareAllowDownload: true,
  recordMicrophone: false,
  recordSystemAudio: true,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await platform.storage.sync.get<Partial<Settings>>(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await platform.storage.sync.set(KEY, next);
  return next;
}

/** Expands {date} {time} {title} {kind} tokens; result is a safe filename without extension. */
export function buildFilename(pattern: string, ctx: { date?: Date; title?: string | null; kind: string }): string {
  const d = ctx.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const out = (pattern || DEFAULT_SETTINGS.filenamePattern)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{title}', (ctx.title ?? '').slice(0, 60))
    .replaceAll('{kind}', ctx.kind);
  // eslint-disable-next-line no-control-regex
  const safe = out.replace(/[\u0000-\u001f<>:"/\\|?*~]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return safe.slice(0, 150) || `SnapShare ${date} ${time}`;
}

/** Normalises the subfolder used under the browser Downloads directory. */
export function safeSubfolder(sub: string): string {
  return sub
    .split(/[\\/]+/)
    // eslint-disable-next-line no-control-regex
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*~]+/g, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/');
}
