// Recover the text under a highlight/rect annotation by intersecting its
// page-normalized rects with pdf.js text items. Used as the fallback when a
// highlight has no captured `content` (e.g. highlights created before the
// "Create Note from Annotations" feature stored the selected text), and for
// rect annotations (which never carried text).
//
// Coordinate systems (see HighlightLayer + lib/annotations.ts):
//   - stored highlight rects are page-normalized 0..1 (cssPx / renderedPageSize),
//     so they are zoom-independent fractions of the page.
//   - pdf.js text items live in PDF user space (y-up, origin bottom-left):
//     transform[4]=x, transform[5]=baseline y, plus width/height.
//   - page.getViewport({scale:1}).convertToViewportPoint maps PDF coords to
//     scale-1 viewport coords (y-down). Multiplying a normalized rect by the
//     scale-1 viewport dims yields the same scale-1 viewport space, so the two
//     can be intersected directly.

import type * as pdfjsLib from "pdfjs-dist";
import type { TextResolver } from "./zoteroNote";

/** Build a text resolver over a loaded pdf.js document. Returns "" for any
 *  page/rects when the doc is null or recovery fails — the caller treats empty
 *  as "no text" and skips the entry. Per-page text content is cached for the
 *  resolver's lifetime (one sync run) so a page with many highlights is read
 *  once. */
export function makePdfTextResolver(doc: pdfjsLib.PDFDocumentProxy | null): TextResolver {
  const cache = new Map<number, PageText>();
  return async (page, rects) => {
    if (!doc || rects.length === 0) return "";
    let pt = cache.get(page);
    if (!pt) {
      pt = await loadPageText(doc, page);
      cache.set(page, pt);
    }
    if (pt.boxes.length === 0) return "";
    const out: string[] = [];
    for (const nr of rects) {
      const hl = {
        left: nr.x * pt.vw,
        top: nr.y * pt.vh,
        right: (nr.x + nr.w) * pt.vw,
        bottom: (nr.y + nr.h) * pt.vh,
      };
      const hits = pt.boxes
        .filter(
          (b) => b.left < hl.right && b.right > hl.left && b.top < hl.bottom && b.bottom > hl.top
        )
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const t = hits
        .map((b) => b.str)
        .join("")
        .trim();
      if (t) out.push(t);
    }
    return out.join(" ").replace(/\s+/g, " ").trim();
  };
}

interface TextBox {
  str: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface PageText {
  boxes: TextBox[];
  vw: number;
  vh: number;
}

async function loadPageText(doc: pdfjsLib.PDFDocumentProxy, page: number): Promise<PageText> {
  try {
    const pdfPage = await doc.getPage(page);
    const vp = pdfPage.getViewport({ scale: 1 });
    const content = await pdfPage.getTextContent();
    pdfPage.cleanup();
    const boxes: TextBox[] = [];
    for (const it of content.items as Array<Record<string, unknown>>) {
      const str = typeof it.str === "string" ? (it.str as string) : "";
      if (!str) continue;
      const tr = Array.isArray(it.transform) ? (it.transform as number[]) : [1, 0, 0, 1, 0, 0];
      const pdfX = typeof tr[4] === "number" ? tr[4] : 0;
      const pdfY = typeof tr[5] === "number" ? tr[5] : 0;
      const w = typeof it.width === "number" ? (it.width as number) : 0;
      const h = typeof it.height === "number" ? (it.height as number) : 0;
      // Baseline is (pdfX, pdfY); the glyph extends up by h. Convert both
      // corners to scale-1 viewport coords to get a y-down bounding box.
      const [bx, by] = vp.convertToViewportPoint(pdfX, pdfY);
      const [tx, ty] = vp.convertToViewportPoint(pdfX + w, pdfY + h);
      boxes.push({
        str,
        left: Math.min(bx, tx),
        top: Math.min(by, ty),
        right: Math.max(bx, tx),
        bottom: Math.max(by, ty),
      });
    }
    return { boxes, vw: vp.width, vh: vp.height };
  } catch {
    return { boxes: [], vw: 0, vh: 0 };
  }
}
