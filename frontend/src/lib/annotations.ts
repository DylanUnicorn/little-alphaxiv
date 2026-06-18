import type { NormPoint, NormRect, PageSize } from "../types";

export const PALETTE = [
  "#FFEB3B", // yellow
  "#A5F3A0", // green
  "#93C5FD", // blue
  "#F9A8D4", // pink
  "#FDBA74", // orange
  "#C4B5FD", // purple
] as const;

export type PageSizeLike = PageSize;

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function newId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizePoint(px: number, py: number, size: PageSize): NormPoint {
  return { x: clamp01(px / size.w), y: clamp01(py / size.h) };
}

export function denormalizePoint(n: NormPoint, size: PageSize): { x: number; y: number } {
  return { x: n.x * size.w, y: n.y * size.h };
}

export function normalizeRect(px: number, py: number, pw: number, ph: number, size: PageSize): NormRect {
  return { x: clamp01(px / size.w), y: clamp01(py / size.h), w: clamp01(pw / size.w), h: clamp01(ph / size.h) };
}

export function denormalizeRect(r: NormRect, size: PageSize): { x: number; y: number; w: number; h: number } {
  return { x: r.x * size.w, y: r.y * size.h, w: r.w * size.w, h: r.h * size.h };
}

/** Convert DOMRect-like rects (relative to the page box, in px) to normalized rects. */
export function rectsToNorm(
  rects: { left: number; top: number; width: number; height: number }[],
  size: PageSize
): NormRect[] {
  return rects.map((r) => ({
    x: clamp01(r.left / size.w),
    y: clamp01(r.top / size.h),
    w: clamp01(r.width / size.w),
    h: clamp01(r.height / size.h),
  }));
}
