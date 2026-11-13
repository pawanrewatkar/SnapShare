/**
 * Destructive mosaic: every block is replaced by its average colour, so the original pixels
 * cannot be recovered from the exported image (unlike a translucent overlay or light blur).
 */
export function pixelateData(data: Uint8ClampedArray, width: number, height: number, block: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  const b = Math.max(1, Math.floor(block));
  for (let by = 0; by < height; by += b) {
    for (let bx = 0; bx < width; bx += b) {
      const w = Math.min(b, width - bx);
      const h = Math.min(b, height - by);
      let r = 0,
        g = 0,
        bl = 0;
      for (let y = by; y < by + h; y++) {
        for (let x = bx; x < bx + w; x++) {
          const i = (y * width + x) * 4;
          r += data[i];
          g += data[i + 1];
          bl += data[i + 2];
        }
      }
      const n = w * h;
      const avg = [r / n, g / n, bl / n, 255];
      for (let y = by; y < by + h; y++) {
        for (let x = bx; x < bx + w; x++) {
          const i = (y * width + x) * 4;
          out[i] = avg[0];
          out[i + 1] = avg[1];
          out[i + 2] = avg[2];
          out[i + 3] = avg[3];
        }
      }
    }
  }
  return out;
}

/** Produces an opaque pixelated canvas of the given region of `source`. */
export function pixelateRegion(source: CanvasImageSource, sx: number, sy: number, w: number, h: number, block: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = pixelateData(img.data, w, h, block);
  img.data.set(px);
  ctx.putImageData(img, 0, 0);
  return canvas;
}
