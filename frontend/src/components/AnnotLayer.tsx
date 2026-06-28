// Annotation layer ABOVE the text layer (z-index 3): rect / draw / text.
// Renders existing annotations AND handles creation:
//   tool==="rect"  -> drag to draw a rectangle (one-shot: resets to "none" after)
//   tool==="draw"  -> drag to draw freehand (STICKY: stays in draw mode so you
//                     can draw many strokes per session; click the toolbar button
//                     again to finish. All strokes in a session share one
//                     annotation — selectable/deletable as a single block.)
//   tool==="text"  -> click to place an editable text box (one-shot)
import { useEffect, useRef, useState } from "react";
import { useAnnotations } from "../store/annotations";
import {
  denormalizeRect, denormalizePoint, normalizePoint, normalizeRect,
} from "../lib/annotations";
import type { PageSize, NormPoint, Annotation } from "../types";

interface Props {
  pageNumber: number;
  pageSize: PageSize;
}

const MIN_SIZE = 0.0075; // ~6px on an 800px page; discard smaller

export function AnnotLayer({ pageNumber, pageSize }: Props) {
  const annots = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type !== "highlight")
  );
  const highlights = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type === "highlight")
  );
  const selectedId = useAnnotations((s) => s.selectedId);
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  const addAnnot = useAnnotations((s) => s.addAnnot);
  const addDrawStroke = useAnnotations((s) => s.addDrawStroke);
  const setTool = useAnnotations((s) => s.setTool);
  const select = useAnnotations((s) => s.select);
  const moveAnnot = useAnnotations((s) => s.moveAnnot);
  const resizeAnnot = useAnnotations((s) => s.resizeAnnot);
  const editAnnot = useAnnotations((s) => s.editAnnot);
  const removeAnnot = useAnnotations((s) => s.removeAnnot);
  const layerRef = useRef<HTMLDivElement>(null);

  // in-progress creation state
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[]>([]);
  const [textBox, setTextBox] = useState<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);
  const draggedRef = useRef(false);
  // id of an existing text annotation currently being re-edited via double-click.
  // While set, the static .annot-text div is swapped for a pre-filled TextInputBox;
  // a committed change goes through editAnnot (an `edit` op), not addAnnot.
  const [editingId, setEditingId] = useState<string | null>(null);

  // selection drag state
  const dragRef = useRef<
    | { mode: "move"; annot: Annotation; startPx: { x: number; y: number }; orig: Annotation }
    | { mode: "resize"; annot: Annotation; handle: string; startPx: { x: number; y: number }; orig: Annotation }
    | null
  >(null);
  const [dragPreview, setDragPreview] = useState<Annotation | null>(null);

  // Highlight click-to-select drag-yield. A highlight target sits on top of the
  // text layer, so its pointerdown (pointer-events: all) intercepts any drag
  // that begins on an existing highlight — including a text drag-select meant
  // to CREATE a new highlight while highlight mode is on. To stay out of the
  // way of creation, we treat a press as a SELECT only if it stays a click; if
  // the pointer drags beyond a small threshold we YIELD (deselect) so the user
  // can re-attempt the text selection on adjacent text. See
  // docs/designs/2026-06-18-pdf-annotation-layer-design.md §6 (highlights are
  // select-only, no move/resize) and the highlight-delete root-cause note.
  const hlDragRef = useRef<{ id: string; startX: number; startY: number } | null>(null);

  function toLayerPx(e: React.PointerEvent): { x: number; y: number } {
    const rect = layerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (tool === "rect") {
      drawingRef.current = true;
      (e.target as Element).setPointerCapture(e.pointerId);
      const p = toLayerPx(e);
      setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 });
    } else if (tool === "draw") {
      drawingRef.current = true;
      (e.target as Element).setPointerCapture(e.pointerId);
      setDraftPoints([toLayerPx(e)]);
    } else if (tool === "text") {
      // A text box is already being edited: ignore further clicks on the layer
      // so the in-progress input can blur+commit. (Clicks landing on the input
      // itself are stopped there.) Without this guard a blank click would
      // reset/move the box instead of committing it — the "two clicks to type"
      // symptom.
      if (textBox) return;
      // Suppress the compatibility mouse events (mousedown/mouseup/click) for
      // this placement press. Otherwise the synthesized click lands on the
      // non-focusable annot-layer and the browser moves focus to <body>,
      // immediately blurring the input we are about to mount+focus — which
      // commits empty and discards the box. (Pointer Events spec: canceling
      // pointerdown forbids the compat mouse events for that pointer.)
      e.preventDefault();
      const p = toLayerPx(e);
      setTextBox({ x: p.x, y: p.y });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drawingRef.current) return;
    const p = toLayerPx(e);
    if (tool === "rect" && draftRect) {
      setDraftRect({ x: draftRect.x, y: draftRect.y, w: p.x - draftRect.x, h: p.y - draftRect.y });
    } else if (tool === "draw") {
      setDraftPoints((pts) => [...pts, p]);
    }
  }

  function onPointerUp() {
    if (tool === "rect" && draftRect) {
      // Canonicalize the px rect BEFORE normalizeRect: dragging up/left yields
      // negative w/h, and normalizeRect clamps w/h to [0,1] via clamp01 — which
      // would zero out a negative width and silently drop the annotation.
      const px = {
        x: draftRect.w < 0 ? draftRect.x + draftRect.w : draftRect.x,
        y: draftRect.h < 0 ? draftRect.y + draftRect.h : draftRect.y,
        w: Math.abs(draftRect.w),
        h: Math.abs(draftRect.h),
      };
      const r = normalizeRect(px.x, px.y, px.w, px.h, pageSize);
      if (r.w >= MIN_SIZE && r.h >= MIN_SIZE) {
        addAnnot({ type: "rect", page: pageNumber, rect: r, color });
      }
      setDraftRect(null);
      setTool("none");
    } else if (tool === "draw" && draftPoints.length > 1) {
      const pts: NormPoint[] = draftPoints.map((p) => normalizePoint(p.x, p.y, pageSize));
      // Sticky freehand: append to the session block (created on first stroke,
      // extended on later strokes). Do NOT reset the tool — stay in draw mode so
      // the next stroke joins the same block until the toolbar button is clicked again.
      addDrawStroke(pageNumber, pts, color, 0.0025);
      setDraftPoints([]);
    }
    drawingRef.current = false;
  }

  function commitText(content: string, boxPx: { x: number; y: number; w: number; h: number }) {
    const trimmed = content.trim();
    if (trimmed) {
      const r = normalizeRect(boxPx.x, boxPx.y, boxPx.w, boxPx.h, pageSize);
      addAnnot({
        type: "text", page: pageNumber,
        text: { x: r.x, y: r.y, w: r.w, h: r.h, content: trimmed, fontSize: 0.0175 },
        color,
      });
    }
    setTextBox(null);
    setTool("none");
  }

  // Commit an in-place edit of an existing text annotation. Mirrors commitText's
  // rules: trim, re-measure, and discard-if-empty — but discard means REMOVE the
  // annotation (you cleared the only text it had), not silently keep the old text.
  // Emits an `edit` op (or `remove` op) so it lands on the undo stack and IDB.
  function commitEdit(
    before: Annotation,
    content: string,
    boxPx: { x: number; y: number; w: number; h: number },
  ) {
    setEditingId(null);
    const trimmed = content.trim();
    if (!trimmed) {
      // cleared the text → remove the annotation (undoable)
      removeAnnot(before.id);
      return;
    }
    // No-op guard: if neither the text nor the box size changed, don't push a
    // redundant `edit` op onto the undo stack (otherwise Undo would appear to
    // do nothing on the surface while consuming one undo step).
    const sizeChanged = Math.abs(boxPx.w - before.text!.w * pageSize.w) > 1 ||
                        Math.abs(boxPx.h - before.text!.h * pageSize.h) > 1;
    if (trimmed === before.text!.content && !sizeChanged) return;
    const r = normalizeRect(boxPx.x, boxPx.y, boxPx.w, boxPx.h, pageSize);
    editAnnot(before, {
      ...before,
      text: {
        x: r.x, y: r.y, w: r.w, h: r.h, content: trimmed,
        fontSize: before.text!.fontSize, // editing never changes font size
      },
    });
  }

  // ---- selection / move / resize (tool === "none") ----
  function startMove(e: React.PointerEvent, a: Annotation) {
    if (tool !== "none") return;
    e.stopPropagation();
    select(a.id);
    draggedRef.current = false;
    const p = toLayerPx(e);
    dragRef.current = { mode: "move", annot: a, startPx: p, orig: a };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function startResize(e: React.PointerEvent, a: Annotation, handle: string) {
    if (tool !== "none") return;
    e.stopPropagation();
    draggedRef.current = false;
    const p = toLayerPx(e);
    dragRef.current = { mode: "resize", annot: a, handle, startPx: p, orig: a };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    draggedRef.current = true;
    const p = toLayerPx(e);
    const dxN = (p.x - d.startPx.x) / pageSize.w;
    const dyN = (p.y - d.startPx.y) / pageSize.h;
    if (d.mode === "move") {
      setDragPreview(moveAnnotGeom(d.orig, dxN, dyN));
    } else {
      setDragPreview(resizeAnnotGeom(d.orig, d.handle, dxN, dyN));
    }
  }

  function onDragUp() {
    const d = dragRef.current;
    if (!d) return;
    if (!draggedRef.current) {
      // bare click to select — no move/resize op
      dragRef.current = null;
      setDragPreview(null);
      return;
    }
    const preview = dragPreview ?? d.orig;
    if (d.mode === "move") moveAnnot(d.orig, preview);
    else resizeAnnot(d.orig, preview);
    dragRef.current = null;
    setDragPreview(null);
  }

  // ---- highlight click-to-select (tool === "none", any highlightOn state) ----
  // Highlights render their transparent click-targets whenever no drawing tool
  // is active — INCLUDING while highlight mode is on, so the user can select an
  // existing highlight and Delete it without first toggling highlight off. The
  // previous `!highlightOn` gate made targets vanish right after creation (the
  // highlight toggle is sticky, unlike one-shot rect/draw/text), so highlights
  // were unselectable exactly when the user had just made one. The drag-yield
  // below keeps creation working: a drag that begins on a highlight deselects
  // instead of sticking, so the user can retry the text selection next to it.
  const HL_DRAG_THRESHOLD = 5; // px; below this a press counts as a click
  function onHighlightDown(e: React.PointerEvent, a: Annotation) {
    if (tool !== "none") return;
    e.stopPropagation();
    select(a.id);
    hlDragRef.current = { id: a.id, startX: e.clientX, startY: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onHighlightMove(e: React.PointerEvent) {
    const d = hlDragRef.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.startX) > HL_DRAG_THRESHOLD ||
        Math.abs(e.clientY - d.startY) > HL_DRAG_THRESHOLD) {
      // This press became a drag — yield so creation (text drag-select) isn't
      // blocked by a now-pointless selection on the highlight we started on.
      select(null);
      hlDragRef.current = null;
    }
  }
  function onHighlightUp() {
    hlDragRef.current = null;
  }

  const interactive = tool === "rect" || tool === "draw" || tool === "text";

  return (
    <div
      className="annot-layer"
      ref={layerRef}
      style={{ pointerEvents: interactive ? "auto" : "none", cursor: tool === "text" ? "text" : interactive ? "crosshair" : "default" }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : (e) => { onDragMove(e); onHighlightMove(e); }}
      onPointerUp={interactive ? onPointerUp : () => { onDragUp(); onHighlightUp(); }}
    >
      <svg
        className="annot-svg"
        width="100%" height="100%"
        viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
        preserveAspectRatio="none"
      >
        {annots.map((a) => {
          const cur = dragPreview && dragPreview.id === a.id ? dragPreview : a;
          if (cur.type === "rect" && cur.rect) {
            const p = denormalizeRect(cur.rect, pageSize);
            return (
              <g key={a.id}>
                <rect
                  x={p.x} y={p.y} width={p.w} height={p.h}
                  fill={a.color} fillOpacity={0.2} stroke={a.color} strokeWidth={1.5}
                  style={{ pointerEvents: tool === "none" ? "stroke" : "none", cursor: tool === "none" ? "move" : "default" }}
                  onPointerDown={(e) => startMove(e, a)}
                />
                {selectedId === a.id && tool === "none" && (
                  <SelectionHandles rect={p} onHandleDown={(h, e) => startResize(e, a, h)} />
                )}
              </g>
            );
          }
          if (cur.type === "draw" && cur.draw) {
            const strokes = cur.draw.strokes;
            const bbox = denormalizeRect(bboxOf(strokes.flat()), pageSize);
            return (
              <g key={a.id}>
                {strokes.map((stroke, i) => {
                  const pts = stroke.map((pt) => { const dp = denormalizePoint(pt, pageSize); return `${dp.x},${dp.y}`; }).join(" ");
                  return (
                    <polyline
                      key={i} points={pts} fill="none" stroke={a.color}
                      strokeWidth={cur.draw!.width * pageSize.w} strokeLinejoin="round" strokeLinecap="round"
                      style={{ pointerEvents: tool === "none" ? "stroke" : "none", cursor: tool === "none" ? "move" : "default" }}
                      onPointerDown={(e) => startMove(e, a)}
                    />
                  );
                })}
                {selectedId === a.id && tool === "none" && (
                  <SelectionHandles rect={bbox} onHandleDown={(h, e) => startResize(e, a, h)} />
                )}
              </g>
            );
          }
          if (cur.type === "text" && cur.text) {
            if (selectedId === a.id && tool === "none") {
              const tpx = denormalizeRect({ x: cur.text.x, y: cur.text.y, w: cur.text.w, h: cur.text.h }, pageSize);
              return (
                <g key={a.id}>
                  <SelectionHandles
                    rect={tpx}
                    onHandleDown={(h, e) => startResize(e, a, h)}
                  />
                </g>
              );
            }
            return null;
          }
          return null;
        })}
        {/* highlight click-targets + selected outline (default mode; any highlightOn).
            Targets are present EVEN while highlight mode is on, so the user can
            click an existing highlight and Delete it right after creating it.
            The highlight toggle is sticky (doesn't reset to "none" like the
            one-shot rect/draw/text tools), so gating targets on !highlightOn
            made them vanish exactly when the user had just made a highlight —
            the "划词后不能删除" bug. Drag-yield (onHighlightMove) keeps text
            drag-select creation working.
            Degenerate (near-zero width/height) rects are skipped: pdf.js
            Range.getClientRects() can emit zero-width phantom rects at line
            starts; rendering a click-target for them produces a dead, unclickable
            zone. The visible highlight layer still draws them (harmless, invisible);
            only the hit-targets are filtered so every target is actually clickable. */}
        {tool === "none" && highlights.map((a) =>
          (a.highlight?.rects ?? []).map((r, i) => {
            const p = denormalizeRect(r, pageSize);
            const selected = a.id === selectedId;
            if (p.w < 1 || p.h < 1) return null; // skip degenerate phantom rects
            return (
              <rect
                key={a.id + "-ht-" + i}
                x={p.x} y={p.y} width={p.w} height={p.h}
                fill="transparent"
                stroke={selected ? "var(--accent)" : "transparent"}
                strokeWidth={1}
                strokeDasharray={selected ? "3 2" : undefined}
                style={{ pointerEvents: "all", cursor: "pointer" }}
                onPointerDown={(e) => onHighlightDown(e, a)}
              />
            );
          })
        )}
        {/* draft rect */}
        {draftRect && (
          <rect
            x={draftRect.x} y={draftRect.y} width={draftRect.w} height={draftRect.h}
            fill={color} fillOpacity={0.2} stroke={color} strokeWidth={1.5}
          />
        )}
        {/* draft polyline */}
        {draftPoints.length > 1 && (
          <polyline
            points={draftPoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          />
        )}
      </svg>

      {annots.filter((a) => a.type === "text" && a.text).map((a) => {
        const cur = dragPreview && dragPreview.id === a.id ? dragPreview : a;
        const t = cur.text!;
        const px = denormalizeRect({ x: t.x, y: t.y, w: t.w, h: t.h }, pageSize);
        const selected = a.id === selectedId;
        // Double-click on a placed text annotation (default mode only) swaps the
        // static div for a pre-filled TextInputBox bound to editingId. The box
        // commits via editAnnot (an `edit` op on the undo stack), not addAnnot.
        // Single-click still falls through to startMove (select + drag) — dblclick
        // fires after the second pointerup, by which point the bare-click path in
        // onDragUp has already resolved as a select (no move), so the two
        // interactions don't fight each other.
        if (editingId === a.id && tool === "none") {
          return (
            <TextInputBox
              key={a.id}
              x={px.x} y={px.y} color={a.color} pageSize={pageSize}
              initialContent={t.content}
              initialFontSize={t.fontSize}
              onCommit={(content, boxPx) => commitEdit(a, content, boxPx)}
              onCancel={() => setEditingId(null)}
            />
          );
        }
        return (
          <div
            key={a.id}
            className={"annot-text" + (selected ? " selected" : "")}
            style={{ left: px.x, top: px.y, width: px.w, minHeight: px.h, color: a.color, fontSize: t.fontSize * pageSize.w, cursor: tool === "none" ? "move" : "default", pointerEvents: tool === "none" ? "auto" : "none" }}
            onPointerDown={(e) => { if (tool === "none") startMove(e, a); }}
            onDoubleClick={(e) => {
              if (tool !== "none") return;
              e.stopPropagation();
              select(a.id);
              setEditingId(a.id);
            }}
          >
            {t.content}
          </div>
        );
      })}

      {/* text input box */}
      {textBox && (
        <TextInputBox
          x={textBox.x} y={textBox.y} color={color} pageSize={pageSize}
          onCommit={(content, boxPx) => commitText(content, boxPx)}
          onCancel={() => { setTextBox(null); setTool("none"); }}
        />
      )}
    </div>
  );
}

function TextInputBox({
  x, y, color, pageSize, onCommit, onCancel,
  initialContent, initialFontSize,
}: {
  x: number; y: number; color: string; pageSize: PageSize;
  onCommit: (content: string, boxPx: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
  // Re-editing an existing text annotation: pre-fill the box with its current
  // content and use its current font size (creation uses the 0.0175 default).
  initialContent?: string;
  initialFontSize?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const committedRef = useRef(false);
  // Font size matches the committed annotation (norm fontSize * page width) so
  // what you type is exactly what gets placed — the box measured at commit then
  // equals the rendered annotation size, and the hit-area hugs the text. When
  // re-editing, honor the annotation's own fontSize so a resized (larger/
  // smaller) annotation doesn't snap back to the 0.0175 creation default.
  const fontSize = (initialFontSize ?? 0.0175) * pageSize.w;

  // Focus on mount + pre-fill when editing an existing annotation. The old code
  // did focus during render, where ref.current is null on the first render, so
  // focus never fired and the user had to click a second time to start typing.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (initialContent != null) {
      // Seed the existing text, then place the caret at the end so typing
      // appends (not replaces) — matches the expectation of editing in place.
      el.innerText = initialContent;
    }
    el.focus();
    // Move caret to end after focus (no-op for an empty creation box).
    const sel = window.getSelection();
    if (sel && el.childNodes.length > 0) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false); // collapse to end
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }, [initialContent]);

  function finish() {
    if (committedRef.current) return;
    committedRef.current = true;
    const el = ref.current;
    if (!el) {
      onCommit("", { x, y, w: 0, h: 0 });
      return;
    }
    // Normalize NBSP (contentEditable sometimes inserts them) and trim, then
    // re-render the trimmed text into the element before measuring so the box
    // hugs the actual placed content rather than trailing whitespace.
    const trimmed = el.innerText.replace(/ /g, " ").trim();
    el.innerText = trimmed;
    // clientWidth/Height = content + padding, excluding the input's 1px border,
    // which exactly matches the committed .annot-text border-box (no border).
    onCommit(trimmed, { x, y, w: el.clientWidth, h: el.clientHeight });
  }

  return (
    <div
      ref={ref}
      className="annot-text-input"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      tabIndex={0}
      style={{ left: x, top: y, color, fontSize, maxWidth: pageSize.w }}
      // Stop propagation so the annot-layer's pointerdown doesn't reset the
      // box while editing (clicking inside to place the caret).
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={finish}
      onPaste={(e) => {
        // Plain-text only: never let rich markup into an annotation.
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain");
        document.execCommand("insertText", false, text);
      }}
      onKeyDown={(e) => {
        // Don't hijack IME composition — Enter confirms the IME candidate, not
        // the box. Critical for CJK input.
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          finish();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committedRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function SelectionHandles({
  rect, onHandleDown,
}: {
  rect: { x: number; y: number; w: number; h: number };
  onHandleDown: (handle: string, e: React.PointerEvent) => void;
}) {
  // Visible dot is small (8px) for a tidy look, but the hit area underneath it
  // is much larger (HIT = 16px). The handle is hard to grab at 8px — you must
  // land a precise pointer exactly on the tiny square — so we render a large
  // transparent rect first (the actual event target) and draw the small dot
  // on top with pointer-events:none. The effective grab radius is doubled and
  // the dot stays visually identical.
  const DOT = 8;
  const HIT = 16;
  const handles: [string, number, number][] = [
    ["nw", rect.x, rect.y],
    ["n", rect.x + rect.w / 2, rect.y],
    ["ne", rect.x + rect.w, rect.y],
    ["e", rect.x + rect.w, rect.y + rect.h / 2],
    ["se", rect.x + rect.w, rect.y + rect.h],
    ["s", rect.x + rect.w / 2, rect.y + rect.h],
    ["sw", rect.x, rect.y + rect.h],
    ["w", rect.x, rect.y + rect.h / 2],
  ];
  return (
    <>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill="none" stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 2" />
      {handles.map(([h, hx, hy]) => (
        // Transparent hit zone: this is what receives the pointerdown. Keep it
        // stacked below the visible dot so the dot's stroke isn't clipped.
        <rect
          key={h}
          x={hx - HIT / 2} y={hy - HIT / 2} width={HIT} height={HIT}
          fill="transparent"
          style={{ cursor: "pointer", pointerEvents: "all" }}
          onPointerDown={(e) => onHandleDown(h, e)}
        />
      ))}
      {handles.map(([h, hx, hy]) => (
        // Visible dot on top — never an event target, just paint.
        <rect
          key={h + "-dot"}
          x={hx - DOT / 2} y={hy - DOT / 2} width={DOT} height={DOT}
          fill="#fff" stroke="var(--accent)" strokeWidth={1}
          style={{ pointerEvents: "none" }}
        />
      ))}
    </>
  );
}

// Move an annotation's geometry by normalized delta.
function moveAnnotGeom(a: Annotation, dxN: number, dyN: number): Annotation {
  if (a.type === "rect" && a.rect) {
    return { ...a, rect: { ...a.rect, x: a.rect.x + dxN, y: a.rect.y + dyN } };
  }
  if (a.type === "draw" && a.draw) {
    return { ...a, draw: { ...a.draw, strokes: a.draw.strokes.map((stroke) => stroke.map((p) => ({ x: p.x + dxN, y: p.y + dyN }))) } };
  }
  if (a.type === "text" && a.text) {
    return { ...a, text: { ...a.text, x: a.text.x + dxN, y: a.text.y + dyN } };
  }
  return a;
}

// Resize by handle. handle in {nw,n,ne,e,se,s,sw,w}. For draw, scale the bounding box.
function resizeAnnotGeom(a: Annotation, handle: string, dxN: number, dyN: number): Annotation {
  if (a.type === "rect" && a.rect) {
    return { ...a, rect: resizeRect(a.rect, handle, dxN, dyN) };
  }
  if (a.type === "text" && a.text) {
    const r = resizeRect({ x: a.text.x, y: a.text.y, w: a.text.w, h: a.text.h }, handle, dxN, dyN);
    // scale font with width
    const scale = a.text.w > 0 ? r.w / a.text.w : 1;
    return { ...a, text: { ...a.text, x: r.x, y: r.y, w: r.w, h: r.h, fontSize: a.text.fontSize * scale, content: a.text.content } };
  }
  if (a.type === "draw" && a.draw) {
    const bbox = bboxOf(a.draw.strokes.flat());
    const r = resizeRect(bbox, handle, dxN, dyN);
    return { ...a, draw: { ...a.draw, strokes: a.draw.strokes.map((stroke) => rescalePoints(stroke, bbox, r)) } };
  }
  return a;
}

function resizeRect(r: { x: number; y: number; w: number; h: number }, handle: string, dxN: number, dyN: number) {
  let { x, y, w, h } = r;
  if (handle.includes("w")) { x += dxN; w -= dxN; }
  if (handle.includes("e")) { w += dxN; }
  if (handle.includes("n")) { y += dyN; h -= dyN; }
  if (handle.includes("s")) { h += dyN; }
  return { x, y, w: Math.max(0.01, w), h: Math.max(0.01, h) };
}

function bboxOf(points: { x: number; y: number }[]) {
  if (points.length === 0) return { x: 0, y: 0, w: 0.001, h: 0.001 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: Math.max(0.001, maxX - minX), h: Math.max(0.001, maxY - minY) };
}

function rescalePoints(points: { x: number; y: number }[], oldBox: { x: number; y: number; w: number; h: number }, newBox: { x: number; y: number; w: number; h: number }) {
  const sx = newBox.w / oldBox.w;
  const sy = newBox.h / oldBox.h;
  return points.map((p) => ({ x: newBox.x + (p.x - oldBox.x) * sx, y: newBox.y + (p.y - oldBox.y) * sy }));
}
