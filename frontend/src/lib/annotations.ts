import type { Annotation, NormPoint, NormRect, PageSize } from "../types";

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

/** Do two page-normalized rects overlap in area? Touching edges (shared edge
 *  but no interior overlap) and zero-area rects return false — so adjacent
 *  line rects that cover different characters do NOT count as overlapping.
 *
 *  A small epsilon absorbs floating-point noise: getClientRects() + the
 *  normalize divide introduce sub-epsilon drift, so two line rects that share
 *  an edge at y=0.15 may compute as 0.15000000000000002 vs 0.15 and would
 *  otherwise be falsely treated as overlapping. */
const RECT_EPS = 1e-6;
export function rectsOverlap(a: NormRect, b: NormRect): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false;
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  return a.x < bx2 - RECT_EPS && b.x < ax2 - RECT_EPS
    && a.y < by2 - RECT_EPS && b.y < ay2 - RECT_EPS;
}

/** Find existing highlight annotation ids on `page` whose rects overlap any of
 *  `newRects`. Used at highlight-creation time to enforce "one color per
 *  character": before adding the new highlight, drop the overlapping existing
 *  ones so colors never stack on the same glyphs. Non-highlight annotations
 *  (rect/draw/text) and other pages are ignored. */
export function overlappingHighlightIds(
  existing: Annotation[],
  page: number,
  newRects: NormRect[]
): string[] {
  if (newRects.length === 0) return [];
  const out: string[] = [];
  for (const a of existing) {
    if (a.page !== page || a.type !== "highlight") continue;
    const rects = a.highlight?.rects ?? [];
    const overlaps = rects.some((r) => newRects.some((nr) => rectsOverlap(r, nr)));
    if (overlaps) out.push(a.id);
  }
  return out;
}
