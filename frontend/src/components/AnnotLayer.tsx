// Annotation layer ABOVE the text layer (z-index 3): rect / draw / text.
// Renders existing annotations AND handles one-shot creation:
//   tool==="rect"  -> drag to draw a rectangle
//   tool==="draw"  -> drag to draw freehand
//   tool==="text"  -> click to place an editable text box
// After commit the tool resets to "none" (one-shot).
import { useRef, useState } from "react";
import { useAnnotations } from "../store/annotations";
import {
  denormalizeRect, denormalizePoint, normalizePoint, normalizeRect,
} from "../lib/annotations";
import type { PageSize, NormPoint } from "../types";

interface Props {
  pageNumber: number;
  pageSize: PageSize;
}

const MIN_SIZE = 0.0075; // ~6px on an 800px page; discard smaller

export function AnnotLayer({ pageNumber, pageSize }: Props) {
  const annots = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type !== "highlight")
  );
  const selectedId = useAnnotations((s) => s.selectedId);
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  const addAnnot = useAnnotations((s) => s.addAnnot);
  const setTool = useAnnotations((s) => s.setTool);
  const select = useAnnotations((s) => s.select);
  const layerRef = useRef<HTMLDivElement>(null);

  // in-progress creation state
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[]>([]);
  const [textBox, setTextBox] = useState<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);

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
      const r = normalizeRect(
        draftRect.x, draftRect.y, draftRect.w, draftRect.h, pageSize
      );
      // normalize negative width/height (drag up/left)
      const fixed = {
        x: r.w < 0 ? r.x + r.w : r.x,
        y: r.h < 0 ? r.y + r.h : r.y,
        w: Math.abs(r.w),
        h: Math.abs(r.h),
      };
      if (fixed.w >= MIN_SIZE && fixed.h >= MIN_SIZE) {
        addAnnot({ type: "rect", page: pageNumber, rect: fixed, color });
      }
      setDraftRect(null);
      setTool("none");
    } else if (tool === "draw" && draftPoints.length > 1) {
      const pts: NormPoint[] = draftPoints.map((p) => normalizePoint(p.x, p.y, pageSize));
      addAnnot({ type: "draw", page: pageNumber, draw: { points: pts, width: 0.0025 }, color });
      setDraftPoints([]);
      setTool("none");
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

  const interactive = tool === "rect" || tool === "draw" || tool === "text";

  return (
    <div
      className="annot-layer"
      ref={layerRef}
      style={{ pointerEvents: interactive ? "auto" : "none", cursor: tool === "text" ? "text" : interactive ? "crosshair" : "default" }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
    >
      <svg
        className="annot-svg"
        width="100%" height="100%"
        viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
        preserveAspectRatio="none"
      >
        {annots.map((a) => {
          if (a.type === "rect" && a.rect) {
            const p = denormalizeRect(a.rect, pageSize);
            return <rect key={a.id} x={p.x} y={p.y} width={p.w} height={p.h} fill={a.color} fillOpacity={0.2} stroke={a.color} strokeWidth={1.5} />;
          }
          if (a.type === "draw" && a.draw) {
            const pts = a.draw.points.map((pt) => { const dp = denormalizePoint(pt, pageSize); return `${dp.x},${dp.y}`; }).join(" ");
            return <polyline key={a.id} points={pts} fill="none" stroke={a.color} strokeWidth={a.draw.width * pageSize.w} strokeLinejoin="round" strokeLinecap="round" />;
          }
          return null;
        })}
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
        const t = a.text!;
        const px = denormalizeRect({ x: t.x, y: t.y, w: t.w, h: t.h }, pageSize);
        const selected = a.id === selectedId;
        return (
          <div key={a.id} className={"annot-text" + (selected ? " selected" : "")}
            style={{ left: px.x, top: px.y, width: px.w, minHeight: px.h, color: a.color, fontSize: t.fontSize * pageSize.w }}
            onPointerDown={() => { if (tool === "none") select(a.id); }}
          >
            {t.content}
          </div>
        );
      })}

      {/* text input box */}
      {textBox && (
        <TextInputBox
          x={textBox.x} y={textBox.y} color={color}
          onCommit={(content, boxPx) => commitText(content, boxPx)}
          onCancel={() => { setTextBox(null); setTool("none"); }}
        />
      )}
    </div>
  );
}

function TextInputBox({
  x, y, color, onCommit, onCancel,
}: {
  x: number; y: number; color: string;
  onCommit: (content: string, boxPx: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState("");
  // focus on mount
  if (ref.current && document.activeElement !== ref.current) {
    setTimeout(() => ref.current?.focus(), 0);
  }
  function finish() {
    const el = ref.current;
    const w = el?.offsetWidth ?? 120;
    const h = el?.offsetHeight ?? 24;
    onCommit(val, { x, y, w, h });
  }
  return (
    <textarea
      ref={ref}
      className="annot-text-input"
      value={val}
      style={{ left: x, top: y, color }}
      onChange={(e) => setVal(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      rows={1}
    />
  );
}
