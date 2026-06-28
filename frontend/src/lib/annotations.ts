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

/**
 * Tighten the per-line rects that `Range.getClientRects()` returns on the
 * pdf.js text layer, so a highlight sits on the visible glyphs and adjacent
 * lines no longer collide. Operates in page-relative px; pass the result to
 * `rectsToNorm`.
 *
 * Why this is needed: pdf.js sizes each text span to the full font height and
 * anchors it at the baseline, so a selection rect's top lives in the ascent
 * space ABOVE the caps and its bottom in the descent space below the baseline.
 * When line leading is tight (leading < font height — common in dense papers),
 * consecutive line rects overlap: the lower rect's top cuts into the upper
 * rect's bottom. That is the "highlight box is too tall / top too high / the
 * lower box interferes with the upper box" bug.
 *
 * Two-step fix:
 *  1. Inset each rect vertically (top more than bottom) to trim the
 *     ascent/descent slack so the rect covers the glyph run, not the full
 *     line box. Brings the top down ("上界太高" → fixed).
 *  2. Guarantee no overlap regardless of leading: sort by top, and for any
 *     rect whose inset top still falls above the previous rect's bottom,
 *     push its top down to sit just below that bottom. Only acts across
 *     distinct lines, so same-line rects (multi-column wrap) are untouched.
 *     ("下面的变色框和上面的干涉" → fixed.)
 *
 * The insets are fractions of the rect height (zoom/DPR-independent). They are
 * deliberately modest so caps/descenders stay covered; step 2 is what actually
 * guarantees non-overlap for arbitrarily tight leading.
 */
export function fitHighlightRects(
  rects: { left: number; top: number; width: number; height: number }[]
): { left: number; top: number; width: number; height: number }[] {
  if (rects.length === 0) return [];
  const TOP_INSET = 0.12;
  const BOTTOM_INSET = 0.06;
  const out = rects.map((r) => {
    const topCut = r.height * TOP_INSET;
    const botCut = r.height * BOTTOM_INSET;
    return {
      left: r.left,
      top: r.top + topCut,
      width: r.width,
      height: Math.max(1, r.height - topCut - botCut),
    };
  });
  out.sort((a, b) => a.top - b.top || a.left - b.left);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const prevBottom = prev.top + prev.height;
    // Only trim across distinct lines (cur clearly lower than prev) whose
    // inset tops still overlap. Same-line rects have near-equal tops and are
    // left alone.
    if (cur.top > prev.top + 1 && cur.top < prevBottom) {
      const origBottom = cur.top + cur.height;
      const newTop = prevBottom + 1; // 1px gap so rects never touch
      if (origBottom > newTop) {
        cur.top = newTop;
        cur.height = origBottom - newTop;
      }
    }
  }
  return out;
}
