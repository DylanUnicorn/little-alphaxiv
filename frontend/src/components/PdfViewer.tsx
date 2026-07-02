// PDF viewer using pdf.js directly.
// Features (per user request):
//   - Continuous vertical scroll (all pages stacked, NO pagination)
//   - Selectable text (pdf.js TextLayer overlay)
//   - Zoom in / out / fit-width
//   - Fills the panel (canvas sized to container width, minimal margin)
//
// Pages render lazily via IntersectionObserver as they scroll into view.

import { useEffect, useRef, useState, useCallback } from "react";
import * as pdfjsLib from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { pdfUrl } from "../lib/api";
import { renderTextLayer, type TextLayerRenderTask } from "../lib/textlayer";
import * as db from "../lib/db";
import {
  loadPdfScroll,
  savePdfScroll,
  computeScrollPos,
  computeFracDelta,
} from "../lib/pdfScrollMemory";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { HighlightLayer } from "./HighlightLayer";
import { AnnotLayer } from "./AnnotLayer";
import { ZoteroPanel } from "./ZoteroPanel";
import { useZoteroNoteSync } from "../hooks/useZoteroNoteSync";
import { Tooltip } from "./Tooltip";
import { useAnnotations } from "../store/annotations";
import type { PageSize } from "../types";

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

interface Props {
  arxivId: string;
  /** When set (non-arXiv OA papers), load the PDF from /api/pdf-url?url=…
   *  instead of the arxiv-id path. */
  pdfUrlOverride?: string;
  /** The arxivId that `pdfUrlOverride` was resolved FOR (or null while PaperView
   *  is still resolving it for the current paper). The doc-load effect refuses to
   *  call getDocument until this equals `arxivId`, so a stale override from the
   *  PREVIOUS paper — which lags one render behind arxivId on a switch — can
   *  never trigger a load of the wrong PDF. Loading state shows meanwhile. */
  pdfUrlForId?: string | null;
  onLoaded?: (numPages: number) => void;
  onTextExtracted?: (text: string) => void;
}

export function PdfViewer({ arxivId, pdfUrlOverride, pdfUrlForId, onLoaded, onTextExtracted }: Props) {
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1); // 1 = fit width
  const [showZotero, setShowZotero] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  // True while a saved scroll position is being restored; suppresses the
  // scroll-save listener so the intermediate scrollIntoView/frac steps don't
  // overwrite the saved value with a transient position.
  const restoringRef = useRef(false);
  // Last-known-good scroll position (page + frac), cached on every debounced
  // scroll-save. The unmount save reads THIS, not the live DOM, because by the
  // time React runs our cleanup during SPA navigation the .pdf-scroll container
  // has already collapsed to zero height — getBoundingClientRect returns
  // all-zeros, which computeScrollPos misreads as "all pages above the
  // viewport" → {page: numPages, frac: 0} → restore jumps to the last page.
  const lastPosRef = useRef<{ page: number; frac: number } | null>(null);

  // "Create Note from Annotations": while enabled for this paper, continuously
  // push highlights + text notes to a child note in Zotero. Needs the pdf.js
  // doc for highlight-text recovery, so it lives here (not in ZoteroPanel).
  useZoteroNoteSync(arxivId, doc);

  // Load document when arxivId or pdfUrlOverride changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDoc(null);
    setNumPages(0);
    // Wait until PaperView confirms the override (or `undefined` for a plain
    // arXiv paper) is resolved for THIS arxivId. On a paper switch the override
    // from the previous paper is still in `pdfUrlOverride` for one render until
    // PaperView's db.getPaper resolves; without this guard we'd fire getDocument
    // with the stale URL and briefly render the wrong PDF — letting the user
    // draw highlights that get saved to the new paper_id with the old paper's
    // coordinates (ghost annotations). `loading` stays true and doc stays null
    // (no PDF to draw on) until the resolution lands and re-triggers this effect.
    if (pdfUrlForId !== arxivId) return;
    pdfjsLib
      .getDocument({ url: pdfUrlOverride || pdfUrl(arxivId) })
      .promise.then(async (d) => {
        if (cancelled) {
          d.destroy();
          return;
        }
        docRef.current = d;
        setDoc(d);
        setNumPages(d.numPages);
        onLoaded?.(d.numPages);
        // The PDF is ready to render NOW. Clear the spinner BEFORE the (slow)
        // full-text extraction so the user sees the first page immediately
        // instead of staring at "Loading PDF…" while we mine text for the
        // chat context. Extraction below is best-effort and must not block
        // the loading indicator or the first-page render.
        setLoading(false);

        try {
          // Repeat visit? The full text is already cached in IndexedDB (saved
          // by PaperView's onTextExtracted last time). Re-extracting would
          // re-walk every page on the worker for nothing — skip it.
          const cached = await db.getPaper(arxivId);
          if (cancelled) return;
          if (cached?.full_text) {
            onTextExtracted?.(cached.full_text);
            return;
          }
          const text = await extractText(d);
          if (!cancelled) onTextExtracted?.(text);
        } catch {
          /* extraction is best-effort */
        }
      })
      .catch((e) => !cancelled && setError(String(e?.message || e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      docRef.current?.destroy();
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arxivId, pdfUrlOverride, pdfUrlForId]);

  // --- Per-paper scroll-position memory (save) ---
  // Debounced (rAF) save of the topmost visible page + fraction on scroll.
  // The unmount save persists lastPosRef (cached on each save), NOT a fresh
  // rect read: at SPA-navigation unmount the .pdf-scroll container has already
  // collapsed to zero height, so a live getBoundingClientRect pass returns
  // all-zeros, which computeScrollPos misreads as "every page above the
  // viewport" → {page: numPages, frac: 0} → restore jumps to the last page.
  // restoringRef suppresses saves during the restore's intermediate steps.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const save = () => {
      raf = 0;
      if (restoringRef.current) return;
      const wraps = container.querySelectorAll<HTMLElement>(".pdf-page-wrap");
      if (!wraps.length) return;
      const cTop = container.getBoundingClientRect().top;
      const rects = Array.from(wraps, (w) => {
        const r = w.getBoundingClientRect();
        return { top: r.top, height: r.height };
      });
      // Defensive: skip degenerate (zero-height) rects — see the unmount note
      // above. Shouldn't happen during normal scrolling, but guards teardown races.
      if (rects[0].height === 0) return;
      const pos = computeScrollPos(rects, cTop);
      if (pos) {
        lastPosRef.current = pos; // cache last-known-good for the unmount save
        savePdfScroll(arxivId, pos);
      }
    };
    const onScroll = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(save);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      // Persist the cached last-known-good position. Do NOT read live rects
      // here — the container has collapsed by cleanup time on SPA navigation.
      if (lastPosRef.current) savePdfScroll(arxivId, lastPosRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arxivId]);

  // --- Per-paper scroll-position memory (restore) ---
  // Once the doc loads and page wraps mount, glide back to the saved page
  // with a short eased animation instead of an instant jump. An instant
  // scrollIntoView flashed page 1 → target on every restore (the container
  // starts at scrollTop 0); gliding makes the transition feel continuous.
  //
  // The glide re-targets every frame by reading the target page-wrap's LIVE
  // rect, so it's robust to the lazy-render placeholder heights shifting as
  // pages render (every page-wrap is always mounted; unrendered ones sit at a
  // 1000px placeholder, so the target's offset is stable mid-glide — only the
  // viewport-adjacent pages render during a fast scroll). After landing on the
  // target page top, the saved fraction is applied as a delta once the target
  // has actually rendered — its real height is needed (placeholder height is
  // bogus). Users with prefers-reduced-motion get the instant restore instead.
  useEffect(() => {
    if (!doc || numPages === 0) return;
    const saved = loadPdfScroll(arxivId);
    if (!saved || saved.page < 1 || saved.page > numPages) return;
    const container = containerRef.current;
    if (!container) return;
    restoringRef.current = true;
    let cancelled = false;
    let raf = 0;
    // Removed on cleanup / on glide completion. Hoisted to effect scope (not
    // inside the rAF) so cleanup can detach even if the rAF never fired, and
    // so the normal completion path can detach without leaking listeners.
    let detachListeners: () => void = () => {};

    // Start one frame later so React has committed the page-wrap divs.
    raf = requestAnimationFrame(() => {
      if (cancelled) return;
      const wraps = container.querySelectorAll<HTMLElement>(".pdf-page-wrap");
      const target = wraps[saved.page - 1];
      if (!target) { restoringRef.current = false; return; }

      // scrollTop that aligns the target page top with the scroll container's
      // top edge (self-corrects for the 12px top padding + sub-pixel residual,
      // and re-read each frame so reflow mid-glide can't derail the landing).
      const goalScrollTop = () => {
        const cTop = container.getBoundingClientRect().top;
        const r = target.getBoundingClientRect();
        return container.scrollTop + (r.top - cTop);
      };

      // If the user scrolls mid-glide, don't fight them — cancel and hand
      // control back (the scroll-save listener takes over, restoringRef clears).
      const cancelByUser = () => {
        if (cancelled) return;
        cancelled = true;
        if (raf) cancelAnimationFrame(raf);
        detachListeners();
        restoringRef.current = false;
      };
      const onKey = (e: KeyboardEvent) => {
        const tgt = e.target as HTMLElement | null;
        // Ignore scroll keys typed into the chat input / a text annot.
        if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
        if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(e.key)) {
          cancelByUser();
        }
      };
      // Idempotent: removeEventListener is a no-op on a never-added/already-
      // removed fn, so calling this on every terminal path is safe.
      detachListeners = () => {
        container.removeEventListener("wheel", cancelByUser);
        container.removeEventListener("touchmove", cancelByUser);
        window.removeEventListener("keydown", onKey);
      };

      // After the glide (or instant set) lands at the target page top, apply
      // the fractional delta. Poll until the target has rendered its real
      // height; bail after 1.5s and apply best-effort. No-op when frac is 0.
      // Detaches the user-scroll listeners on completion (or on cancel, via
      // the cancelled-flag bail) so they don't outlive the restore.
      const finishAtTarget = () => {
        if (cancelled) { detachListeners(); restoringRef.current = false; return; }
        if (saved.frac <= 0) { detachListeners(); restoringRef.current = false; return; }
        const startedAt = performance.now();
        const poll = () => {
          if (cancelled) return;
          const rendered = target.dataset.rendered === "1";
          if (!rendered && performance.now() - startedAt < 1500) {
            raf = requestAnimationFrame(poll);
            return;
          }
          const cTop = container.getBoundingClientRect().top;
          const r = target.getBoundingClientRect();
          const delta = computeFracDelta({ top: r.top, height: r.height }, cTop, saved.frac);
          container.scrollTop += delta;
          detachListeners();
          restoringRef.current = false;
        };
        raf = requestAnimationFrame(poll);
      };

      const goal = goalScrollTop();
      const startTop = container.scrollTop;
      const distance = Math.abs(goal - startTop);
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      // Already positioned, saved page 1 at top, or reduced-motion user → no
      // glide; land instantly (the old scrollIntoView behavior). No listeners
      // were attached, so finishAtTarget's detach is a no-op.
      if (reducedMotion || distance < 2) {
        container.scrollTop = goal;
        finishAtTarget();
        return;
      }

      // Ease-out glide. Duration scales with distance (short hops feel gentle,
      // long jumps cap fast so deep positions don't drag).
      const duration = Math.min(650, Math.max(220, distance / 5));
      const startedAt = performance.now();
      const tick = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
        const g = goalScrollTop(); // re-read: robust to reflow
        container.scrollTop = startTop + (g - startTop) * eased;
        if (t < 1) raf = requestAnimationFrame(tick);
        else finishAtTarget();
      };

      container.addEventListener("wheel", cancelByUser, { passive: true });
      container.addEventListener("touchmove", cancelByUser, { passive: true });
      window.addEventListener("keydown", onKey);

      raf = requestAnimationFrame(tick);
    });

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      detachListeners();
      restoringRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, arxivId, numPages]);


  const zoomIn = useCallback(() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(2))), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(2))), []);
  const fitWidth = useCallback(() => setZoom(1), []);

  // Annotation keyboard shortcuts: undo / redo / delete / esc.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      // ignore when typing in an input/textarea/contenteditable (chat or text annot)
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useAnnotations.getState().redo();
        else useAnnotations.getState().undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        useAnnotations.getState().redo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace")) {
        const s = useAnnotations.getState();
        if (s.selectedId) { e.preventDefault(); s.removeAnnot(s.selectedId); }
        return;
      }
      if (e.key === "Escape") {
        const s = useAnnotations.getState();
        // priority: clear text selection; clear selection; (highlight toggle stays)
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) { sel.removeAllRanges(); return; }
        if (s.selectedId) { s.select(null); return; }
        if (s.tool !== "none") { s.setTool("none"); }
      }
    }

    // Click-to-deselect: in default mode, clicking blank PDF area clears the
    // current annotation selection. Annotation elements (text box, rect/draw
    // strokes, handles, highlight targets) all call stopPropagation on their
    // own pointerdown, so they never reach this document listener — only blank
    // clicks do. Scoped to .pdf-scroll so toolbar/chat clicks keep the
    // selection. (React 18 root-listener + stopPropagation shields this.)
    function onPointerDown(e: PointerEvent) {
      const s = useAnnotations.getState();
      if (s.tool !== "none" || !s.selectedId) return;
      const target = e.target as Element | null;
      if (target && target.closest(".pdf-scroll")) {
        s.select(null);
      }
    }

    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <Tooltip label="Zoom out" side="bottom">
          <button onClick={zoomOut}>−</button>
        </Tooltip>
        <Tooltip label="Fit width" side="bottom">
          <button onClick={fitWidth} className="zoom-pct">
            {Math.round(zoom * 100)}%
          </button>
        </Tooltip>
        <Tooltip label="Zoom in" side="bottom">
          <button onClick={zoomIn}>+</button>
        </Tooltip>
        <AnnotationToolbar />
        <Tooltip label="Zotero — find / add / organize this paper" side="bottom">
          <button
            className={`zotero-btn ${showZotero ? "active" : ""}`}
            onClick={() => setShowZotero((v) => !v)}
            aria-label="Zotero"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M8.5 8h7L8.5 16h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </Tooltip>
        <span className="pdf-pagecount">{numPages ? `${numPages} pages` : "…"}</span>
      </div>
      <div className="pdf-scroll" ref={containerRef}>
        {loading && <div className="pdf-loading">Loading PDF…</div>}
        {error && <div className="pdf-error">Failed to load PDF: {error}</div>}
        {doc &&
          Array.from({ length: numPages }, (_, i) => (
            <PdfPage
              key={i}
              doc={doc}
              pageNumber={i + 1}
              zoom={zoom}
              containerWidth={containerRef.current?.clientWidth ?? 800}
            />
          ))}
      </div>
      {showZotero && <ZoteroPanel arxivId={arxivId} onClose={() => setShowZotero(false)} />}
    </div>
  );
}

async function extractText(doc: pdfjsLib.PDFDocumentProxy): Promise<string> {
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const lines = groupIntoLines(content.items);
    pages.push(`--- Page ${i} ---\n${lines.join("\n")}`);
    page.cleanup();
  }
  return pages.join("\n\n");
}

interface TextItemLike {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

function groupIntoLines(items: any[]): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  let lastY: number | null = null;
  for (const it of items as TextItemLike[]) {
    const y = it.transform?.[5] ?? 0;
    if (lastY !== null && Math.abs(y - lastY) > 3) {
      if (current.length) lines.push(current.join(""));
      current = [];
    }
    if (it.str) current.push(it.str);
    if (it.hasEOL) {
      if (current.length) lines.push(current.join(""));
      current = [];
      lastY = null;
      continue;
    }
    lastY = y;
  }
  if (current.length) lines.push(current.join(""));
  return lines;
}

function PdfPage({
  doc,
  pageNumber,
  zoom,
  containerWidth,
}: {
  doc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  containerWidth: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [pageSize, setPageSize] = useState<PageSize>({ w: 0, h: 0 });

  // Lazy-mount: only render when the page scrolls near the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
          }
        }
      },
      { rootMargin: "800px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Render canvas + text layer when visible or when zoom/width changes.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let textTask: TextLayerRenderTask | null = null;
    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) {
        page.cleanup();
        return;
      }
      // scale so the page fills the container width at zoom=1
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = ((containerWidth - 24) / baseViewport.width) * zoom;
      const viewport = page.getViewport({ scale });
      setPageSize({ w: viewport.width, h: viewport.height });

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d")!;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        try {
          await page.render({ canvasContext: ctx, viewport }).promise;
        } catch {
          /* render cancelled */
        }
      }

      // text layer for selection
      const tl = textLayerRef.current;
      if (tl) {
        tl.innerHTML = "";
        // pdf.js v4 TextLayer reads --scale-factor from the container to scale
        // the text spans; without it the spans are mis-sized and selection fails.
        tl.style.setProperty("--scale-factor", String(scale));
        tl.style.width = `${viewport.width}px`;
        tl.style.height = `${viewport.height}px`;
        const textContent = await page.getTextContent();
        if (cancelled) return;
        textTask = renderTextLayer({
          textContentSource: textContent,
          container: tl,
          viewport,
        });
        try {
          await textTask.promise;
        } catch {
          /* ignore */
        }
      }
      setRendered(true);
      // Signal to the scroll-restore logic (PdfViewer) that this page has
      // finished rendering and its wrap height is now real (not the 1000px
      // placeholder). Restoring a saved fractional scroll position waits on
      // this before applying its delta.
      wrapRef.current?.setAttribute("data-rendered", "1");
      page.cleanup();
    })();
    return () => {
      cancelled = true;
      textTask?.cancel();
    };
  }, [doc, pageNumber, visible, zoom, containerWidth]);

  return (
    <div className="pdf-page-wrap" ref={wrapRef}>
      <div className="pdf-page-canvas-wrap" style={{ minHeight: rendered ? undefined : 1000 }}>
        <canvas ref={canvasRef} />
        <HighlightLayer pageNumber={pageNumber} pageSize={pageSize} />
        <div className="pdf-textlayer" ref={textLayerRef} />
        <AnnotLayer pageNumber={pageNumber} pageSize={pageSize} />
      </div>
    </div>
  );
}
