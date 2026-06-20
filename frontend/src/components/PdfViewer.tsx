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
  onLoaded?: (numPages: number) => void;
  onTextExtracted?: (text: string) => void;
}

export function PdfViewer({ arxivId, pdfUrlOverride, onLoaded, onTextExtracted }: Props) {
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1); // 1 = fit width
  const [showZotero, setShowZotero] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

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
  }, [arxivId, pdfUrlOverride]);

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
