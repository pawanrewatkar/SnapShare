/** Pure geometry helpers for annotations (unit-tested). */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : 1));
}

export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > current + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < current - 1e-6) ?? MIN_ZOOM;
}

export function fitZoom(imageW: number, imageH: number, viewW: number, viewH: number): number {
  if (imageW <= 0 || imageH <= 0) return 1;
  return clampZoom(Math.min(1, viewW / imageW, viewH / imageH));
}

/** SVG path for an arrow from (x1,y1) to (x2,y2) with an open chevron head sized relative to stroke width. */
export function arrowPath(x1: number, y1: number, x2: number, y2: number, strokeWidth: number): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const head = Math.min(len * 0.5, Math.max(12, strokeWidth * 4));
  const spread = Math.PI / 7;
  const hx1 = x2 - head * Math.cos(angle - spread);
  const hy1 = y2 - head * Math.sin(angle - spread);
  const hx2 = x2 - head * Math.cos(angle + spread);
  const hy2 = y2 - head * Math.sin(angle + spread);
  const r = (n: number) => Math.round(n * 100) / 100;
  return `M ${r(x1)} ${r(y1)} L ${r(x2)} ${r(y2)} M ${r(hx1)} ${r(hy1)} L ${r(x2)} ${r(y2)} L ${r(hx2)} ${r(hy2)}`;
}

/** Integer crop rect clamped to the image. Returns null if too small to be meaningful. */
export function clampCrop(r: { x: number; y: number; width: number; height: number }, imageW: number, imageH: number, min = 4) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const right = Math.min(imageW, Math.ceil(r.x + r.width));
  const bottom = Math.min(imageH, Math.ceil(r.y + r.height));
  const width = right - x;
  const height = bottom - y;
  if (width < min || height < min) return null;
  return { x, y, width, height };
}

/** Block size for pixelation that stays strong on small and large regions. */
export function blurBlockSize(width: number, height: number): number {
  return Math.max(8, Math.round(Math.min(width, height) / 10));
}
