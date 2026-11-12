import { clamp, type MaskRect } from './model';

export type Point = { x: number; y: number };
export const MIN_MASK_SIZE = 0.01;

export function maskFromPoints(a: Point, b: Point): MaskRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function moveMask(rect: MaskRect, dx: number, dy: number): MaskRect {
  return {
    ...rect,
    x: clamp(rect.x + dx, 0, 1 - rect.width),
    y: clamp(rect.y + dy, 0, 1 - rect.height),
  };
}

export function resizeMask(rect: MaskRect, dx: number, dy: number): MaskRect {
  return {
    ...rect,
    width: clamp(rect.width + dx, MIN_MASK_SIZE, 1 - rect.x),
    height: clamp(rect.height + dy, MIN_MASK_SIZE, 1 - rect.y),
  };
}

// Round outward so even a partial source pixel is covered before zooming.
export function maskPixels(rect: MaskRect, width: number, height: number) {
  const x = Math.floor(rect.x * width),
    y = Math.floor(rect.y * height);
  return {
    x,
    y,
    width: Math.ceil((rect.x + rect.width) * width) - x,
    height: Math.ceil((rect.y + rect.height) * height) - y,
  };
}
