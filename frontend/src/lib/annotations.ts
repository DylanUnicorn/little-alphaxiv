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
  // Drop zero-area phantom rects BEFORE sorting. pdf.js Range.getClientRects()
  // on a multi-line selection emits zero-width phantom rects at left=0 near the
  // page top (one per visual line the range passes through, including lines
  // above the visible selection). Because we sort by (top, left) below, an
  // unfiltered phantom at a small top sorts FIRST and becomes out[0] — and
  // HighlightLayer places the color bubble at out[0], so the bubble pops at the
  // page's TOP-LEFT corner instead of at the selected text. A zero-area rect is
  // never a real selection portion (it paints nothing), so dropping it is safe
  // for both the bubble position and the stored highlight geometry. The < 1px
  // threshold matches the render-time degenerate-rect skip and also clears
  // sub-pixel noise.
  const clean = rects.filter((r) => r.width >= 1 && r.height >= 1);
  if (clean.length === 0) return [];
  const TOP_INSET = 0.18;
  const BOTTOM_INSET = 0.10;
  const out = clean.map((r) => {
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

/**
 * Render-time de-overlap for highlight pixel rects.
 *
 * Guarantees that consecutive line rects within a single highlight annotation
 * never overlap vertically — regardless of how the rects were captured or
 * stored. This is the visual safety net: even old highlights with raw
 * getClientRects() dimensions render cleanly.
 *
 * Operates on denormalized page-pixel rects ({ x, y, w, h }). Sorts by
 * top; when a lower rect's top intrudes above the previous rect's bottom
 * AND the two rects are clearly on different lines (tops separated by more
 * than SAME_LINE_PX), pushes the lower rect's top down to exactly the
 * previous rect's bottom, preserving its original bottom edge.
 * Same-line rects (multi-column wrap) are left untouched.
 */
export function deoverlapPixelRects(
  rects: { x: number; y: number; w: number; h: number }[]
): { x: number; y: number; w: number; h: number }[] {
  if (rects.length <= 1) return rects;
  const out = rects.map((r) => ({ ...r }));
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  const SAME_LINE_PX = 4; // tops within 4px = same visual line (multi-column wrap)
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const prevBottom = prev.y + prev.h;
    // Only act on distinct lines whose rects still overlap after any prior
    // adjustments. Same-line rects (near-equal tops) are left alone.
    if (cur.y > prev.y + SAME_LINE_PX && cur.y < prevBottom) {
      const origBottom = cur.y + cur.h;
      cur.y = prevBottom; // push down to sit exactly below the upper rect
      if (origBottom >= cur.y) {
        cur.h = origBottom - cur.y;
      } else {
        // Degenerate: rect fully consumed by overlap. Give it 1px height.
        cur.h = 1;
      }
    }
  }
  return out;
}

/**
 * Migrate a legacy freehand annotation to the current multi-stroke shape.
 *
 * Pre-grouping draw annotations stored `draw: { points: NormPoint[]; width }`
 * — one annotation per stroke. Freehand is now a sticky tool that groups a
 * whole drawing session (enter draw mode → N strokes → exit) into ONE
 * annotation with `draw: { strokes: NormPoint[][]; width }`, so the block can
 * be selected and deleted as a unit. This converts the old single-stroke shape
 * to a one-element `strokes` array on load.
 *
 * Idempotent: annotations already carrying `strokes` pass through unchanged;
 * non-draw annotations are returned as-is. The legacy `points` field is read
 * via a cast because the `Annotation` type no longer types it.
 */
export function migrateAnnotation(a: Annotation): Annotation {
  if (a.type !== "draw" || !a.draw) return a;
  const d = a.draw as { strokes?: NormPoint[][]; points?: NormPoint[]; width: number };
  if (Array.isArray(d.strokes)) return a;
  if (Array.isArray(d.points)) {
    return { ...a, draw: { strokes: [d.points], width: d.width } };
  }
  return a;
}
