import { platform } from '@/browser';
import { getSettings, safeSubfolder } from './settings';

export class ClipboardUnsupportedError extends Error {}

/** Copies a PNG image to the system clipboard so it can be pasted into Slack, ClickUp, email, etc. */
export async function copyImageToClipboard(blob: Blob): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new ClipboardUnsupportedError('Copying images is not supported in this browser context.');
  }
  let png = blob;
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    png = await c.convertToBlob({ type: 'image/png' });
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === 'NotAllowedError') throw new Error('Clipboard access was blocked. Click inside the SnapShare window and try again.');
    throw new Error(`Could not copy image: ${(e as Error).message}`);
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for contexts where the async clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Could not copy to clipboard');
  }
}

export function extensionFor(mime: string): string {
  if (mime === 'video/webm') return 'webm';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

/** Saves a blob through chrome.downloads into the configured subfolder; revokes the object URL afterwards. */
export async function downloadBlob(blob: Blob, baseName: string): Promise<void> {
  const settings = await getSettings();
  const ext = extensionFor(blob.type);
  const name = baseName.toLowerCase().endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;
  const folder = safeSubfolder(settings.downloadSubfolder);
  const url = URL.createObjectURL(blob);
  try {
    const id = await platform.download(url, folder ? `${folder}/${name}` : name, settings.askWhereToSave);
    const cleanup = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') {
        URL.revokeObjectURL(url);
        chrome.downloads.onChanged.removeListener(cleanup);
      }
    };
    chrome.downloads.onChanged.addListener(cleanup);
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(`Download failed: ${(e as Error).message}`);
  }
}
