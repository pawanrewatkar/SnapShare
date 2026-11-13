import { describe, expect, it } from 'vitest';
import { HistoryStack } from '@/features/editor/history';
import { arrowPath, blurBlockSize, clampCrop, clampZoom, fitZoom, nextZoom } from '@/features/editor/geometry';
import { pixelateData } from '@/features/editor/pixelate';

describe('HistoryStack (undo/redo)', () => {
  it('undoes and redoes in order', () => {
    const h = new HistoryStack('a');
    h.push('b');
    h.push('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe('b');
    expect(h.present).toBe('b');
  });
  it('clears redo after a new change', () => {
    const h = new HistoryStack(0);
    h.push(1);
    h.undo();
    h.push(2);
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBeNull();
  });
  it('enforces the history limit', () => {
    const h = new HistoryStack(0, 3);
    for (let i = 1; i <= 10; i++) h.push(i);
    let n = 0;
    while (h.undo() !== null) n++;
    expect(n).toBe(3);
    expect(h.present).toBe(7);
  });
  it('reset drops past and future', () => {
    const h = new HistoryStack('x');
    h.push('y');
    h.reset('z');
    expect(h.canUndo).toBe(false);
    expect(h.present).toBe('z');
  });
});

describe('annotation geometry', () => {
  it('draws an arrow ending exactly at the target point', () => {
    const d = arrowPath(0, 0, 100, 0, 4);
    expect(d.startsWith('M 0 0 L 100 0')).toBe(true);
    expect(d.match(/L 100 0/g)?.length).toBe(2); // shaft and head both end at the tip
  });
  it('clamps crop to the image and rejects tiny crops', () => {
    expect(clampCrop({ x: -10, y: 5.5, width: 50, height: 2000 }, 100, 100)).toEqual({ x: 0, y: 5, width: 40, height: 95 });
    expect(clampCrop({ x: 10, y: 10, width: 2, height: 50 }, 100, 100)).toBeNull();
  });
  it('clamps and steps zoom', () => {
    expect(clampZoom(100)).toBe(4);
    expect(clampZoom(0)).toBe(0.1);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(nextZoom(1, 1)).toBe(1.25);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(fitZoom(4000, 1000, 1000, 1000)).toBe(0.25);
    expect(fitZoom(100, 100, 1000, 1000)).toBe(1);
  });
  it('uses a strong blur block size', () => {
    expect(blurBlockSize(20, 20)).toBe(8);
    expect(blurBlockSize(400, 300)).toBe(30);
  });
});

describe('pixelate (blur export)', () => {
  it('replaces every block with a uniform opaque average so detail cannot be recovered', () => {
    const w = 8,
      h = 8;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const on = (i + Math.floor(i / w)) % 2 === 0; // checkerboard = "text"
      data.set(on ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4);
    }
    const out = pixelateData(data, w, h, 4);
    for (let by = 0; by < h; by += 4)
      for (let bx = 0; bx < w; bx += 4) {
        const first = Array.from(out.slice((by * w + bx) * 4, (by * w + bx) * 4 + 4));
        for (let y = by; y < by + 4; y++)
          for (let x = bx; x < bx + 4; x++) expect(Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4))).toEqual(first);
      }
    expect(out[3]).toBe(255);
    expect(Array.from(out)).not.toEqual(Array.from(data));
    expect(out[0]).toBeGreaterThan(100); // grey average, neither black nor white
    expect(out[0]).toBeLessThan(160);
  });
  it('handles edge blocks smaller than the block size', () => {
    const data = new Uint8ClampedArray(5 * 3 * 4).fill(200);
    const out = pixelateData(data, 5, 3, 4);
    expect(out.length).toBe(data.length);
    expect(out[out.length - 4]).toBe(200);
  });
});
