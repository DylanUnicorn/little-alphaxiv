// Per-paper PDF scroll-position memory.
//
// The PDF viewer (PdfViewer.tsx) unmounts when you leave /paper/:arxivId (e.g.
// open Settings) and remounts when you come back — and on a hard refresh — so
// the browser's native scroll position is lost every time. This module
// persists the topmost visible page + the fraction scrolled into it, keyed per
// paper (arxivId), so reopening a paper lands you back where you were reading.
//
// Why page + fraction (not a raw pixel offset): pages render lazily via
// IntersectionObserver and start at a 1000px placeholder height before they
// paint, so the document's total scrollHeight is unknown and unstable until a
// page renders. A page index is a stable anchor (every page-wrap element is
// always mounted); the fraction is then applied as a delta after the target
// page finishes rendering. Survives zoom/width changes too — the fraction is
// relative to the (current) page height, not absolute pixels.
//
// Per-paper, not per-conversation: the PDF is shared across all threads of a
// paper, and PdfViewer stays mounted across thread switches within one paper,
// so this only needs to fire on unmount/remount. Storage is localStorage (same
// convention as the `lax-paper-ratio` panel-divider ratio in PaperView):
// ephemeral view state, not user-created data, so it doesn't belong in the
// server DB alongside annotations.

export interface PdfScrollPos {
  /** 1-indexed page number of the topmost visible page. */
  page: number;
  /** 0..1 — how far the scroll container's top edge has scrolled INTO that page. */
  frac: number;
}

/** localStorage key for a paper's saved scroll position. */
export function scrollKey(arxivId: string): string {
  return `lax-pdf-scroll:${arxivId}`;
}

/** Clamp to [0, 1]. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Compute {page, frac} for the topmost visible page from the rects of each
 * page-wrap element (in viewport coordinates) and the scroll container's
 * viewport top. Pure — no DOM access — so it's testable in a node environment.
 *
 * `rects[i]` corresponds to page `i + 1` (pages render in order). The topmost
 * visible page is the LAST rect whose top is at or above the container's top
 * edge; once a rect's top dips below the container top, all later (further
 * down) pages are also below — so we stop.
 *
 * `frac` = how many px of that page are scrolled above the viewport top,
 * divided by the page height. 0 = page top aligned with viewport top; ~1 = at
 * the page bottom.
 */
export function computeScrollPos(
  rects: ReadonlyArray<{ top: number; height: number }>,
  containerTop: number,
): PdfScrollPos | null {
  if (rects.length === 0) return null;
  let topIdx = 0;
  for (let i = 0; i < rects.length; i++) {
    if (rects[i].top - containerTop <= 1) topIdx = i;
    else break;
  }
  const r = rects[topIdx];
  const scrolledPast = containerTop - r.top; // px of this page above the viewport top
  const frac = r.height > 0 ? clamp01(scrolledPast / r.height) : 0;
  return { page: topIdx + 1, frac };
}

/**
 * After `scrollIntoView({ block: "start" })` aligns the target page's top to
 * the scroll container's viewport top, return how many more px to scroll DOWN
 * to land at `savedFrac` within that page.
 *
 * `scrolledPast` (containerTop - targetRect.top) is ~0 right after
 * scrollIntoView, but `.pdf-scroll` has 12px top padding and sub-pixel layout
 * can leave a small residual — computing the delta from the live rect
 * self-corrects for both. The caller must ensure `targetRect.height` is the
 * REAL rendered height (not the 1000px placeholder) before applying the delta.
 */
export function computeFracDelta(
  targetRect: { top: number; height: number },
  containerTop: number,
  savedFrac: number,
): number {
  const scrolledPast = containerTop - targetRect.top;
  return savedFrac * targetRect.height - scrolledPast;
}

/** Load a paper's saved scroll position, or null if none / corrupt. */
export function loadPdfScroll(arxivId: string): PdfScrollPos | null {
  try {
    const raw = localStorage.getItem(scrollKey(arxivId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PdfScrollPos>;
    const page = Number(parsed.page);
    const frac = Number(parsed.frac);
    if (!Number.isFinite(page) || !Number.isFinite(frac) || page < 1) return null;
    return { page: Math.floor(page), frac: clamp01(frac) };
  } catch {
    return null;
  }
}

/** Save a paper's current scroll position. */
export function savePdfScroll(arxivId: string, pos: PdfScrollPos): void {
  try {
    localStorage.setItem(scrollKey(arxivId), JSON.stringify(pos));
  } catch {
    /* quota / private mode — best-effort, ignore */
  }
}
