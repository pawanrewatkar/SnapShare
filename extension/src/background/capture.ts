import { platform, type TabInfo } from '@/browser';
import { newId, putCapture } from '@/services/db';
import { getSession } from '@/services/api';
import { uploadCapture } from '@/features/drive/driveService';
import { buildFilename, getSettings } from '@/services/settings';
import { cssRectToImageRect, planOutputSize, planScrollPositions } from '@/features/screenshot/stitch';
import { blobToBitmap, canvasToPng, createCanvas, cropBitmap, dataUrlToBlob } from '@/utils/image';
import type { CaptureMode, CaptureResult, PageMetrics, Rect } from '@/types/messages';

/** captureVisibleTab is limited to 2 calls/second by Chrome; keep a safety margin. */
const CAPTURE_INTERVAL_MS = 550;
let lastCaptureAt = 0;
let busy = false;
let pendingRegion: { tab: TabInfo } | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttledCapture(windowId: number): Promise<string> {
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await platform.captureVisibleTab(windowId);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(msg)) {
      await sleep(1000);
      return platform.captureVisibleTab(windowId);
    }
    throw e;
  } finally {
    lastCaptureAt = Date.now();
  }
}

export function explainCaptureError(e: unknown, url?: string): string {
  const msg = String((e as Error)?.message ?? e);
  if (url && /^(chrome|edge|about|chrome-extension|devtools):/.test(url)) return 'Chrome does not allow capturing browser internal pages. Open a regular web page and try again.';
  if (url && /chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(url)) return 'Chrome does not allow extensions to capture the Chrome Web Store.';
  if (/activeTab|permission|Cannot access|cannot be scripted/i.test(msg)) return 'SnapShare does not have permission for this page. Click the SnapShare icon on the page and try again.';
  return msg || 'Capture failed';
}

async function saveScreenshot(blob: Blob, width: number, height: number, tab: TabInfo): Promise<string> {
  const settings = await getSettings();
  const id = newId();
  await putCapture({
    id,
    kind: 'screenshot',
    blob,
    mimeType: 'image/png',
    filename: buildFilename(settings.filenamePattern, { title: tab.title, kind: 'screenshot' }),
    size: blob.size,
    width,
    height,
    durationMs: null,
    createdAt: Date.now(),
    parentId: null,
    sourceUrl: tab.url ?? null,
    sourceTitle: tab.title ?? null,
    cloud: null,
  });
  return id;
}

/** Optional auto-upload (Settings). Failures are non-fatal: the capture stays on the device and can be uploaded later. */
export async function maybeAutoUpload(captureId: string) {
  const settings = await getSettings();
  if (!settings.autoUploadToDrive || !(await getSession())) return;
  try {
    await uploadCapture(captureId);
  } catch (e) {
    await platform.storage.local.set('lastAutoUploadError', { captureId, message: (e as Error).message, at: Date.now() });
  }
}

async function afterCapture(captureId: string) {
  void maybeAutoUpload(captureId);
  const settings = await getSettings();
  if (settings.openEditorAfterCapture) await platform.openExtensionPage(`editor.html?id=${encodeURIComponent(captureId)}`);
  else await platform.openExtensionPage(`gallery.html?highlight=${encodeURIComponent(captureId)}`, { active: false });
}

async function captureVisible(tab: TabInfo): Promise<CaptureResult> {
  const dataUrl = await throttledCapture(tab.windowId);
  const blob = await dataUrlToBlob(dataUrl);
  const bmp = await blobToBitmap(blob);
  const id = await saveScreenshot(blob, bmp.width, bmp.height, tab);
  bmp.close();
  await afterCapture(id);
  return { ok: true, captureId: id };
}

async function startRegion(tab: TabInfo): Promise<CaptureResult> {
  await platform.injectContentScript(tab.id);
  pendingRegion = { tab };
  await platform.storage.session.set('pendingRegion', tab);
  await platform.sendToTab(tab.id, { type: 'region:select' });
  return { ok: true };
}

/** Called when the content script reports the user's selection (or cancellation). */
export async function completeRegion(rect: Rect | null, viewportWidth: number, senderTabId?: number): Promise<CaptureResult> {
  const tab = pendingRegion?.tab ?? (await platform.storage.session.get<TabInfo>('pendingRegion')) ?? null;
  pendingRegion = null;
  await platform.storage.session.remove('pendingRegion');
  if (!tab || (senderTabId !== undefined && senderTabId !== tab.id)) return { ok: false, error: 'No region capture in progress' };
  if (!rect) return { ok: false, error: 'cancelled' };
  const dataUrl = await throttledCapture(tab.windowId);
  const full = await blobToBitmap(await dataUrlToBlob(dataUrl));
  const r = cssRectToImageRect(rect, viewportWidth, full.width, full.height);
  if (r.width < 1 || r.height < 1) {
    full.close();
    return { ok: false, error: 'Selected area is empty' };
  }
  const blob = await cropBitmap(full, r.x, r.y, r.width, r.height);
  full.close();
  const id = await saveScreenshot(blob, r.width, r.height, tab);
  await afterCapture(id);
  return { ok: true, captureId: id };
}

type FullMetrics = PageMetrics & { clip: Rect; innerWidth: number };

async function captureFullPage(tab: TabInfo): Promise<CaptureResult> {
  const settings = await getSettings();
  await platform.injectContentScript(tab.id);
  const send = <T>(m: unknown) => platform.sendToTab<T>(tab.id, m);
  await send({ type: 'page:progress', label: 'Preparing page (loading lazy content)…', progress: null });
  let m = await send<FullMetrics>({ type: 'page:prepare', hideFixed: settings.hideFixedElementsOnFullPage });
  try {
    m = await send<FullMetrics>({ type: 'page:metrics' });
    const { positions, truncated } = planScrollPositions(m.scrollHeight, m.viewportHeight);
    let out: OffscreenCanvas | null = null;
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    let scale = 1;
    let imgScale = 1;
    let coveredUntil = 0;
    for (let i = 0; i < positions.length; i++) {
      await send({ type: 'page:progress', label: `Capturing full page ${i + 1}/${positions.length}`, progress: i / positions.length });
      const { y } = await send<{ y: number }>({ type: 'page:scrollTo', y: positions[i] });
      const bmp = await blobToBitmap(await dataUrlToBlob(await throttledCapture(tab.windowId)));
      if (!out) {
        imgScale = bmp.width / m.innerWidth; // device pixels per CSS px actually captured
        const plan = planOutputSize(m.clip.width, m.scrollHeight, imgScale);
        scale = plan.scale;
        out = createCanvas(plan.width, plan.height);
        ctx = out.getContext('2d');
        if (!ctx) throw new Error('Canvas not supported');
      }
      // Draw only the not-yet-covered part of this frame to avoid duplicating content.
      const frameTop = y;
      const frameBottom = y + m.viewportHeight;
      const drawFrom = Math.max(frameTop, coveredUntil);
      if (drawFrom < frameBottom) {
        const srcY = (m.clip.y + (drawFrom - frameTop)) * imgScale;
        const srcH = (frameBottom - drawFrom) * imgScale;
        ctx!.drawImage(bmp, m.clip.x * imgScale, srcY, m.clip.width * imgScale, srcH, 0, drawFrom * scale, m.clip.width * scale, (frameBottom - drawFrom) * scale);
        coveredUntil = frameBottom;
      }
      bmp.close();
    }
    await send({ type: 'page:progress', label: 'Stitching image…', progress: 1 });
    // Trim to actual covered height (pages can shrink while scrolling).
    let final = out!;
    const coveredPx = Math.min(final.height, Math.floor(coveredUntil * scale));
    if (coveredPx > 0 && coveredPx < final.height) {
      const trimmed = createCanvas(final.width, coveredPx);
      trimmed.getContext('2d')!.drawImage(final, 0, 0);
      final = trimmed;
    }
    const blob = await canvasToPng(final);
    const id = await saveScreenshot(blob, final.width, final.height, tab);
    await send({ type: 'page:restore' });
    await afterCapture(id);
    return { ok: true, captureId: id, error: truncated ? 'Page was very long; capture was truncated.' : undefined };
  } catch (e) {
    await send({ type: 'page:restore' }).catch(() => undefined);
    throw e;
  }
}

async function captureScreen(): Promise<CaptureResult> {
  // getDisplayMedia needs a visible document with the browser picker; the recorder page hosts it.
  await platform.openExtensionPage('recorder.html?action=screenshot');
  return { ok: true };
}

export async function runCapture(mode: CaptureMode, tabId?: number): Promise<CaptureResult> {
  if (busy && mode !== 'screen') return { ok: false, error: 'Another capture is in progress' };
  const tab = mode === 'screen' ? null : tabId !== undefined ? await platform.getTab(tabId) : await platform.getActiveTab();
  if (mode !== 'screen' && !tab) return { ok: false, error: 'No active tab to capture' };
  busy = true;
  try {
    // captureVisibleTab always captures the window's *active* tab, so make sure that's the target.
    if (tab && tabId !== undefined) {
      await platform.focusTab(tab.id);
      await sleep(150);
    }
    switch (mode) {
      case 'visible':
        return await captureVisible(tab!);
      case 'region':
        return await startRegion(tab!);
      case 'fullpage':
        return await captureFullPage(tab!);
      case 'screen':
        return await captureScreen();
    }
  } catch (e) {
    return { ok: false, error: explainCaptureError(e, tab?.url) };
  } finally {
    busy = false;
  }
}
