// Annotation layer ABOVE the text layer (z-index 3): rect / draw / text.
// This task renders existing annotations only. Creation + selection are added later.
import { useRef } from "react";
import { useAnnotations } from "../store/annotations";
import { denormalizeRect, denormalizePoint } from "../lib/annotations";
import type { PageSize } from "../types";

interface Props {
  pageNumber: number;
  pageSize: PageSize;
}

export function AnnotLayer({ pageNumber, pageSize }: Props) {
  const annots = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type !== "highlight")
  );
  const selectedId = useAnnotations((s) => s.selectedId);
  const layerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="annot-layer" ref={layerRef}>
      <svg
        className="annot-svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
        preserveAspectRatio="none"
      >
        {annots.map((a) => {
          if (a.type === "rect" && a.rect) {
            const p = denormalizeRect(a.rect, pageSize);
            return (
              <rect
                key={a.id}
                x={p.x} y={p.y} width={p.w} height={p.h}
                fill={a.color} fillOpacity={0.2}
                stroke={a.color} strokeWidth={1.5}
              />
            );
          }
          if (a.type === "draw" && a.draw) {
            const pts = a.draw.points
              .map((pt) => {
                const dp = denormalizePoint(pt, pageSize);
                return `${dp.x},${dp.y}`;
              })
              .join(" ");
            return (
              <polyline
                key={a.id}
                points={pts}
                fill="none"
                stroke={a.color}
                strokeWidth={a.draw.width * pageSize.w}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          }
          return null;
        })}
      </svg>

      {/* text annotations as HTML divs (sized in px) */}
      {annots
        .filter((a) => a.type === "text" && a.text)
        .map((a) => {
          const t = a.text!;
          const px = denormalizeRect({ x: t.x, y: t.y, w: t.w, h: t.h }, pageSize);
          const selected = a.id === selectedId;
          return (
            <div
              key={a.id}
              className={"annot-text" + (selected ? " selected" : "")}
              style={{
                left: px.x, top: px.y, width: px.w, minHeight: px.h,
                color: a.color,
                fontSize: t.fontSize * pageSize.w,
              }}
            >
              {t.content}
            </div>
          );
        })}
    </div>
  );
}
