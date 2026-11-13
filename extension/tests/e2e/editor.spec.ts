import { expect, test, type Page } from '@playwright/test';

/** Real Chromium + real Fabric.js canvas: verifies exported pixels, not UI state. */
type Px = { width: number; height: number; data: number[] };
const at = (p: Px, x: number, y: number) => p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4);

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator('canvas.upper-canvas').boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:5179/tests/e2e/harness.html');
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
});

test('blur genuinely replaces pixels in the exported PNG and undo restores them', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.engine.setTool('blur'));
  await drag(page, [20, 20], [120, 80]);
  const out: Px = await page.evaluate(() => (window as any).harness.exportPixels());
  const orig: Px = await page.evaluate(() => (window as any).harness.originalPixels());
  expect(out.width).toBe(200);
  // stripes alternate every 2px in the original; inside the blurred area neighbours are now identical (mosaic)
  expect(at(orig, 40, 40)).not.toEqual(at(orig, 42, 40));
  expect(at(out, 40, 40)).toEqual(at(out, 42, 40));
  const v = at(out, 40, 40)[0];
  expect(v).toBeGreaterThan(60);
  expect(v).toBeLessThan(200); // grey average, original black/white detail destroyed
  // outside the blur nothing changed
  expect(at(out, 150, 120)).toEqual(at(orig, 150, 120));
  await page.evaluate(() => (window as any).harness.engine.undo());
  const undone: Px = await page.evaluate(() => (window as any).harness.exportPixels());
  expect(at(undone, 40, 40)).toEqual(at(orig, 40, 40));
});

test('crop changes export dimensions; reset restores the original', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.engine.setTool('crop'));
  await drag(page, [50, 30], [150, 110]);
  await page.evaluate(() => (window as any).harness.engine.applyCrop());
  const out: Px = await page.evaluate(() => (window as any).harness.exportPixels());
  expect(Math.abs(out.width - 100)).toBeLessThanOrEqual(2);
  expect(Math.abs(out.height - 80)).toBeLessThanOrEqual(2);
  await page.evaluate(() => (window as any).harness.engine.resetAll());
  const reset: Px = await page.evaluate(() => (window as any).harness.exportPixels());
  expect([reset.width, reset.height]).toEqual([200, 150]);
});

test('annotations: draw rect/arrow/ellipse/highlight, delete selection, clear, undo/redo', async ({ page }) => {
  for (const [tool, a, b] of [['rect', [10, 10], [60, 60]], ['arrow', [70, 10], [150, 60]], ['ellipse', [10, 80], [60, 140]], ['highlight', [80, 80], [180, 120]]] as const) {
    await page.evaluate((t) => (window as any).harness.engine.setTool(t), tool);
    await drag(page, a as [number, number], b as [number, number]);
  }
  expect(await page.evaluate(() => (window as any).harness.objectCount())).toBe(4);
  const out: Px = await page.evaluate(() => (window as any).harness.exportPixels());
  const orig: Px = await page.evaluate(() => (window as any).harness.originalPixels());
  expect(at(out, 11, 35)).not.toEqual(at(orig, 11, 35)); // rectangle stroke rendered into export
  await page.evaluate(() => {
    const e = (window as any).harness.engine;
    e.setTool('select');
    e.canvas.setActiveObject(e.canvas.getObjects()[0]);
    e.deleteSelected();
  });
  expect(await page.evaluate(() => (window as any).harness.objectCount())).toBe(3);
  await page.evaluate(() => (window as any).harness.engine.undo());
  expect(await page.evaluate(() => (window as any).harness.objectCount())).toBe(4);
  await page.evaluate(() => (window as any).harness.engine.redo());
  expect(await page.evaluate(() => (window as any).harness.objectCount())).toBe(3);
  await page.evaluate(() => (window as any).harness.engine.clearAnnotations());
  expect(await page.evaluate(() => (window as any).harness.objectCount())).toBe(0);
});

test('text comments can be added and styled', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.engine.setTool('text'));
  const box = (await page.locator('canvas.upper-canvas').boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + 30);
  await page.keyboard.type('Bug here');
  await page.evaluate(() => {
    const e = (window as any).harness.engine;
    e.setTextStyle({ bold: true, fontSize: 32 });
  });
  const style = await page.evaluate(() => (window as any).harness.engine.status().textStyle);
  expect(style).toMatchObject({ bold: true, fontSize: 32 });
});
