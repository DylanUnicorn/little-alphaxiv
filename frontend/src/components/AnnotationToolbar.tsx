// PDF annotation toolbar: color, 4 tools, undo/redo.
// Tools: text/rect/draw are one-shot (set tool; PdfViewer resets to "none" after commit).
// highlight is a toggle (highlightOn).
//
// Color control: a framed slot styled like the tool buttons. The chip is empty
// (no color) while dormant — no tool selected and highlight off — so the toolbar
// reads as a row of uniform neutral icons instead of one jarring solid color
// block. When a function is triggered (any tool on, or highlight on) the chip
// fills with the current color; the caret to its right opens a dropdown palette.
import { useEffect, useRef, useState } from "react";
import { useAnnotations, useCanUndo, useCanRedo } from "../store/annotations";
import { PALETTE } from "../lib/annotations";
import type { Tool } from "../types";
import { Tooltip } from "./Tooltip";

export function AnnotationToolbar() {
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  const highlightOn = useAnnotations((s) => s.highlightOn);
  const setTool = useAnnotations((s) => s.setTool);
  const setColor = useAnnotations((s) => s.setColor);
  const toggleHighlight = useAnnotations((s) => s.toggleHighlight);
  const undo = useAnnotations((s) => s.undo);
  const redo = useAnnotations((s) => s.redo);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // A "function" is triggered when any annotation tool is selected or highlight
  // is on. Only then does the chip show a color (per the redesign spec).
  const colorActive = tool !== "none" || highlightOn;

  const onTool = (t: Tool) => setTool(tool === t ? "none" : t);

  // Close the palette on outside click or Escape.
  useEffect(() => {
    if (!paletteOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPaletteOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPaletteOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen]);

  return (
    <div className="annot-toolbar">
      <div
        className={"annot-color-control" + (colorActive ? " active" : "")}
        ref={wrapRef}
      >
        <Tooltip label={colorActive ? "Color" : "Color (select a tool first)"} side="bottom">
          <button
            className="annot-color-trigger"
            aria-haspopup="listbox"
            aria-expanded={paletteOpen}
            onClick={() => setPaletteOpen((v) => !v)}
          >
            <span
              className={"annot-color-chip" + (colorActive ? "" : " empty")}
              style={colorActive ? { background: color } : undefined}
            />
            <span className="annot-color-caret" aria-hidden="true">▾</span>
          </button>
        </Tooltip>
        {paletteOpen && (
          <div className="annot-palette" role="listbox" aria-label="Annotation color">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={"annot-swatch" + (c === color ? " selected" : "")}
                style={{ background: c }}
                aria-label={c}
                aria-selected={c === color}
                role="option"
                onClick={() => {
                  setColor(c);
                  setPaletteOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <Tooltip label="Text" side="bottom">
        <button
          className={"annot-tool-btn" + (tool === "text" ? " active" : "")}
          onClick={() => onTool("text")}
        >📝</button>
      </Tooltip>
      <Tooltip label="Rectangle" side="bottom">
        <button
          className={"annot-tool-btn" + (tool === "rect" ? " active" : "")}
          onClick={() => onTool("rect")}
        >▭</button>
      </Tooltip>
      <Tooltip label="Freehand" side="bottom">
        <button
          className={"annot-tool-btn" + (tool === "draw" ? " active" : "")}
          onClick={() => onTool("draw")}
        >✏️</button>
      </Tooltip>
      <Tooltip label="Highlight (toggle)" side="bottom">
        <button
          className={"annot-tool-btn" + (highlightOn ? " active" : "")}
          onClick={toggleHighlight}
        >🖍️</button>
      </Tooltip>

      <span className="annot-sep" />
      <Tooltip label="Undo (Ctrl+Z)" side="bottom">
        <button
          className="annot-tool-btn"
          disabled={!canUndo}
          onClick={undo}
        >↶</button>
      </Tooltip>
      <Tooltip label="Redo (Ctrl+Shift+Z)" side="bottom">
        <button
          className="annot-tool-btn"
          disabled={!canRedo}
          onClick={redo}
        >↷</button>
      </Tooltip>
    </div>
  );
}
