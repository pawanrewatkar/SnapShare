import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Loads the real unpacked extension (test build in dist-e2e with <all_urls> so captures don't need a
 * toolbar click) and runs real captureVisibleTab / scripting / stitching against a local page.
 * Does NOT cover: Google sign-in, Drive, tabCapture/getDisplayMedia pickers (need a human) — see docs/TESTING.md.
 */
const EXT = resolve(import.meta.dirname, '../../dist-e2e');
const FIXTURE = 'http://localhost:5179/tests/e2e/fixtures/long.html';
let ctx: BrowserContext;
let extId: string;

test.beforeAll(async () => {
  ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
});
test.afterAll(async () => ctx?.close());

async function extPage(path: string): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/${path}`);
  return p;
}

async function send(page: Page, msg: unknown) {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), msg) as Promise<{ ok: boolean; result?: any; error?: string }>;
}

async function readCapture(page: Page, id: string) {
  return page.evaluate(
    (cid) =>
      new Promise<{ width: number; height: number; kind: string; size: number } | null>((res, rej) => {
        const open = indexedDB.open('snapshare');
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const r = open.result.transaction('captures').objectStore('captures').get(cid);
          r.onsuccess = () => res(r.result ? { width: r.result.width, height: r.result.height, kind: r.result.kind, size: r.result.size } : null);
        };
      }),
    id,
  );
}

async function fixtureTab() {
  const page = await ctx.newPage();
  const url = `${FIXTURE}?n=${Math.random().toString(36).slice(2)}`;
  await page.goto(url);
  const helper = await extPage('popup.html');
  const tabId = await helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)!.id, url);
  await helper.close();
  await page.bringToFront();
  return { page, tabId };
}

test('popup, gallery and settings pages render without errors', async () => {
  for (const path of ['popup.html', 'gallery.html', 'settings.html']) {
    const p = await extPage(path);
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await expect(p.locator('#root')).not.toBeEmpty();
    await p.waitForTimeout(300);
    expect(errors).toEqual([]);
    await p.close();
  }
  const popup = await extPage('popup.html');
  await expect(popup.getByText('Visible area')).toBeVisible();
  await expect(popup.getByText('Start recording')).toBeVisible();
  const st = await send(popup, { type: 'rec:status' });
  expect(st.result.phase).toBe('idle');
});

test('visible-area capture stores a viewport-sized PNG and opens the editor', async () => {
  const { tabId } = await fixtureTab();
  const ctl = await extPage('popup.html');
  const editorPromise = ctx.waitForEvent('page', (p) => p.url().includes('editor.html'));
  const r = await send(ctl, { type: 'capture', mode: 'visible', tabId });
  expect(r.ok && r.result.ok).toBe(true);
  const cap = await readCapture(ctl, r.result.captureId);
  expect(cap?.kind).toBe('screenshot');
  expect(cap?.width).toBeGreaterThanOrEqual(980);
  expect(cap?.height).toBe(700);
  const editor = await editorPromise;
  await expect(editor.getByText('Download PNG')).toBeVisible();
});

test('full-page capture stitches the whole page without duplicating the sticky header', async () => {
  const { page, tabId } = await fixtureTab();
  await page.evaluate(() => window.scrollTo(0, 123));
  const ctl = await extPage('popup.html');
  const r = await send(ctl, { type: 'capture', mode: 'fullpage', tabId });
  expect(r.result?.ok).toBe(true);
  const cap = await readCapture(ctl, r.result.captureId);
  expect(cap?.height).toBeGreaterThanOrEqual(3050);
  expect(cap?.height).toBeLessThanOrEqual(3080);
  // scroll position restored
  expect(await page.evaluate(() => window.scrollY)).toBe(123);
  // inspect stitched pixels: band colours at expected offsets, header only at the top
  const colors = await ctl.evaluate(async (cid) => {
    const db: IDBDatabase = await new Promise((res) => {
      const o = indexedDB.open('snapshare');
      o.onsuccess = () => res(o.result);
    });
    const rec: any = await new Promise((res) => {
      const g = db.transaction('captures').objectStore('captures').get(cid);
      g.onsuccess = () => res(g.result);
    });
    const bmp = await createImageBitmap(rec.blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d')!;
    x.drawImage(bmp, 0, 0);
    const px = (yy: number) => Array.from(x.getImageData(500, yy, 1, 1).data.slice(0, 3));
    return { header: px(30), red: px(300), green: px(800), blue: px(1300), black: px(3000), at760: px(760), at1460: px(1460) };
  }, r.result.captureId);
  expect(colors.header).toEqual([255, 0, 255]);
  expect(colors.red).toEqual([255, 0, 0]);
  expect(colors.green).toEqual([0, 255, 0]);
  expect(colors.blue).toEqual([0, 0, 255]);
  expect(colors.black).toEqual([0, 0, 0]);
  expect(colors.at760).not.toEqual([255, 0, 255]); // sticky header not repeated
  expect(colors.at1460).not.toEqual([255, 0, 255]);
});

test('region capture: overlay selection is cropped to the selected size; Esc cancels', async () => {
  const { page, tabId } = await fixtureTab();
  const ctl = await extPage('popup.html');
  await page.bringToFront();
  const start = await send(ctl, { type: 'capture', mode: 'region', tabId });
  expect(start.result?.ok).toBe(true);
  await page.bringToFront();
  await page.waitForSelector('[data-snapshare="region"]', { state: 'attached' });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-snapshare="region"]')).toHaveCount(0);

  await send(ctl, { type: 'capture', mode: 'region', tabId });
  await page.bringToFront();
  await page.waitForSelector('[data-snapshare="region"]', { state: 'attached' });
  const editorPromise = ctx.waitForEvent('page', (p) => p.url().includes('editor.html'));
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(250, 200, { steps: 5 });
  await page.mouse.move(400, 300, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  const editor = await editorPromise;
  const id = new URL(editor.url()).searchParams.get('id')!;
  const cap = await readCapture(ctl, id);
  expect(cap?.width).toBe(300);
  expect(cap?.height).toBe(200);
});

test('capturing a browser-internal page fails with a clear message', async () => {
  const p = await ctx.newPage();
  await p.goto('chrome://version');
  const ctl = await extPage('popup.html');
  const tabId = await ctl.evaluate(async () => (await chrome.tabs.query({ url: 'chrome://version/*' }))[0]?.id);
  const r = await send(ctl, { type: 'capture', mode: 'fullpage', tabId });
  expect(r.result.ok).toBe(false);
  expect(r.result.error).toMatch(/internal pages/);
});
