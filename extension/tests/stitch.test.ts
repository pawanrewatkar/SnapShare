import { describe, expect, it } from 'vitest';
import { cssRectToImageRect, MAX_CANVAS_SIDE, normalizeRect, planOutputSize, planScrollPositions } from '@/features/screenshot/stitch';

describe('planScrollPositions', () => {
  it('covers the page without gaps and clamps the last frame', () => {
    const { positions, truncated } = planScrollPositions(2500, 1000);
    expect(positions).toEqual([0, 1000, 1500]);
    expect(truncated).toBe(false);
    // every pixel row is covered by some frame
    for (let y = 0; y < 2500; y += 50) expect(positions.some((p) => y >= p && y < p + 1000)).toBe(true);
  });
  it('returns a single frame for short pages', () => {
    expect(planScrollPositions(600, 1000).positions).toEqual([0]);
    expect(planScrollPositions(1000, 1000).positions).toEqual([0]);
  });
  it('has no duplicate positions for exact multiples', () => {
    expect(planScrollPositions(3000, 1000).positions).toEqual([0, 1000, 2000]);
  });
  it('truncates extremely long pages', () => {
    const r = planScrollPositions(1_000_000, 1000, 10);
    expect(r.positions).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });
  it('handles a zero viewport defensively', () => {
    expect(planScrollPositions(1000, 0).positions).toEqual([0]);
  });
});

describe('planOutputSize', () => {
  it('keeps device pixel ratio for normal pages', () => {
    expect(planOutputSize(1280, 4000, 2)).toEqual({ width: 2560, height: 8000, scale: 2 });
  });
  it('scales down pages taller than the canvas limit', () => {
    const r = planOutputSize(1280, 50_000, 2);
    expect(r.height).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
    expect(r.scale).toBeLessThan(2);
    expect(r.width / r.height).toBeCloseTo(1280 / 50_000, 2);
  });
});

describe('region geometry', () => {
  it('normalizes reversed drags and clamps to bounds', () => {
    expect(normalizeRect(300, 200, 100, 50, 250, 1000)).toEqual({ x: 100, y: 50, width: 150, height: 150 });
  });
  it('maps CSS pixels to image pixels using the capture scale', () => {
    expect(cssRectToImageRect({ x: 10, y: 20, width: 100, height: 50 }, 1000, 2000, 1200)).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });
  it('clips rects that overflow the image', () => {
    const r = cssRectToImageRect({ x: 950, y: 0, width: 200, height: 10 }, 1000, 1000, 600);
    expect(r.x + r.width).toBeLessThanOrEqual(1000);
  });
});
