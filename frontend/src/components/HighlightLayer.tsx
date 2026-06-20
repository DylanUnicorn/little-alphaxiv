// Highlight layer: renders highlight rects BELOW the text layer (z-index 1).
// When highlightOn, a text selection inside this page shows a color bubble;
// picking a color creates a highlight annotation from the selection's client rects.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnnotations } from "../store/annotations";
import { rectsToNorm, denormalizeRect } from "../lib/annotations";
import { PALETTE } from "../lib/annotations";
import type { PageSize } from "../types";

interface Props {
  pageNumber: number;
  pageSize: PageSize;
}

interface BubblePos { x: number; y: number; }

export function HighlightLayer({ pageNumber, pageSize }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const highlightOn = useAnnotations((s) => s.highlightOn);
  const color = useAnnotations((s) => s.color);
  const addAnnot = useAnnotations((s) => s.addAnnot);
  const annots = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type === "highlight")
  );
  const [bubble, setBubble] = useState<BubblePos | null>(null);
  const pendingRef = useRef<{ rects: { left: number; top: number; width: number; height: number }[]; text: string } | null>(null);

  // The color bubble must be CLICKABLE. It cannot live inside this .highlight-layer:
  // .highlight-layer is z-index 1 (a stacking context), so any child — even one
  // styled z-index: 5 — paints BELOW .pdf-textlayer (z-index 2, pointer-events:
  // auto, covers the whole page). The bubble would be visible (the textlayer is
  // transparent) but pointer-blocked: clicks on the swatches hit the textlayer
  // instead, pickColor never runs, and the highlight is never applied. That was
  // the bug. Fix: portal the bubble up to .pdf-page-canvas-wrap (this layer's
  // parent), where z-index 5 puts it ABOVE the textlayer and annot-layer and the
  // swatches receive their mousedown. The page-relative bubble coords still work
  // because .pdf-page-canvas-wrap (position: relative) is the same offset parent.
  const [bubbleHost, setBubbleHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setBubbleHost(wrapRef.current?.parentElement ?? null);
  }, []);

  // On mouseup anywhere, if highlightOn and selection is within this page, show bubble.
  useEffect(() => {
    function onUp() {
      if (!highlightOn) return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setBubble(null);
        pendingRef.current = null;
        return;
      }
      const range = sel.getRangeAt(0);
      // The text the user selects lives in .pdf-textlayer, a SIBLING of this
      // .highlight-layer (both children of .pdf-page-canvas-wrap). So the "is this
      // selection in my page?" check must use the page container, not wrap.
      const pageWrap = wrap.parentElement; // pdf-page-canvas-wrap
      if (!pageWrap) return;
      if (!pageWrap.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== pageWrap) {
        return;
      }
      const pageRect = pageWrap.getBoundingClientRect();
      const clientRects = Array.from(range.getClientRects()).map((r) => {
        return {
          left: r.left - pageRect.left,
          top: r.top - pageRect.top,
          width: r.width,
          height: r.height,
        };
      });
      if (clientRects.length === 0) return;
      // Capture the selected text now (the bubble's onMouseDown preventDefault
      // keeps the selection alive until a color is picked) so highlights carry
      // their content for the "Create Note from Annotations" sync.
      pendingRef.current = { rects: clientRects, text: sel.toString().trim() };
      // place bubble above the first rect
      setBubble({ x: clientRects[0].left, y: clientRects[0].top - 32 });
    }
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [highlightOn]);

  function pickColor(c: string) {
    const p = pendingRef.current;
    if (!p) return;
    const rects = rectsToNorm(p.rects, pageSize);
    if (rects.length === 0) return;
    addAnnot({
      type: "highlight",
      page: pageNumber,
      highlight: { rects, ...(p.text ? { content: p.text } : {}) },
      color: c,
    });
    pendingRef.current = null;
    setBubble(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div
      className="highlight-layer"
      ref={wrapRef}
      style={{ pointerEvents: highlightOn ? "auto" : "none" }}
    >
      {annots.map((a) =>
        (a.highlight?.rects ?? []).map((r, i) => {
          const p = denormalizeRect(r, pageSize);
          return (
            <div
              key={a.id + "-" + i}
              className="highlight-rect"
              style={{
                left: p.x, top: p.y, width: p.w, height: p.h,
                background: a.color,
              }}
            />
          );
        })
      )}
      {bubble && bubbleHost && createPortal(
        <div className="highlight-bubble" style={{ left: bubble.x, top: bubble.y }}>
          {PALETTE.map((c) => (
            <button
              key={c}
              className={"highlight-bubble-swatch" + (c === color ? " selected" : "")}
              style={{ background: c }}
              onMouseDown={(e) => { e.preventDefault(); pickColor(c); }}
            />
          ))}
        </div>,
        bubbleHost
      )}
    </div>
  );
}
