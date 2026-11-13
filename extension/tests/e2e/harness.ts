import { EditorEngine } from '@/features/editor/engine';

/** Test-only page: exposes the real editor engine on window for Playwright. */
async function makeStripes(w: number, h: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  for (let x = 0; x < w; x += 2) {
    ctx.fillStyle = (x / 2) % 2 ? '#000000' : '#ffffff';
    ctx.fillRect(x, 0, 2, h);
  }
  return new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
}

async function pixels(blob: Blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) };
}

const engine = new EditorEngine(document.getElementById('c') as HTMLCanvasElement);
const original = await makeStripes(200, 150);
await engine.load(original);
engine.setZoom(1);

Object.assign(window, {
  harness: {
    engine,
    exportPixels: async () => pixels(await engine.exportPng()),
    originalPixels: async () => pixels(original),
    objectCount: () => engine.canvas.getObjects().length,
  },
  ready: true,
});
