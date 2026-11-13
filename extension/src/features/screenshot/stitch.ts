/** Pure geometry for full-page capture and region cropping (unit-tested). */

/** Chrome canvas limits: max side 32767 px and roughly 268M pixels of area. */
export const MAX_CANVAS_SIDE = 32_767;
export const MAX_CANVAS_AREA = 268_435_456;
export const MAX_FRAMES = 80;

/**
 * Scroll offsets needed to cover [0, scrollHeight) with frames of viewportHeight.
 * The last frame is clamped to scrollHeight - viewportHeight so no blank space is captured;
 * overlap is resolved by drawing each frame at its real offset.
 */
export function planScrollPositions(scrollHeight: number, viewportHeight: number, maxFrames = MAX_FRAMES): { positions: number[]; truncated: boolean } {
  if (viewportHeight <= 0) return { positions: [0], truncated: false };
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);
  const positions: number[] = [];
  for (let y = 0; y < maxScroll; y += viewportHeight) positions.push(Math.round(y));
  if (positions[positions.length - 1] !== maxScroll) positions.push(Math.round(maxScroll));
  if (positions.length === 0) positions.push(0);
  if (positions.length > maxFrames) return { positions: positions.slice(0, maxFrames), truncated: true };
  return { positions, truncated: false };
}

/** Output canvas size and the scale applied to stay within browser canvas limits. */
export function planOutputSize(cssWidth: number, cssHeight: number, pixelRatio: number): { width: number; height: number; scale: number } {
  let scale = pixelRatio;
  const w = cssWidth * scale;
  const h = cssHeight * scale;
  const sideFactor = Math.min(1, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h);
  const areaFactor = Math.min(1, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
  scale *= Math.min(sideFactor, areaFactor);
  return { width: Math.max(1, Math.floor(cssWidth * scale)), height: Math.max(1, Math.floor(cssHeight * scale)), scale };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Converts a CSS-pixel rect to image pixels for an image that is imageWidth wide for a viewport viewportCssWidth wide. */
export function cssRectToImageRect(rect: Rect, viewportCssWidth: number, imageWidth: number, imageHeight: number): Rect {
  const s = imageWidth / viewportCssWidth;
  const x = Math.max(0, Math.round(rect.x * s));
  const y = Math.max(0, Math.round(rect.y * s));
  const width = Math.min(imageWidth - x, Math.round(rect.width * s));
  const height = Math.min(imageHeight - y, Math.round(rect.height * s));
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/** Normalises a drag from (x1,y1) to (x2,y2) into a positive rect clamped to bounds. */
export function normalizeRect(x1: number, y1: number, x2: number, y2: number, maxW = Infinity, maxH = Infinity): Rect {
  const left = Math.max(0, Math.min(x1, x2));
  const top = Math.max(0, Math.min(y1, y2));
  const right = Math.min(maxW, Math.max(x1, x2));
  const bottom = Math.min(maxH, Math.max(y1, y2));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
