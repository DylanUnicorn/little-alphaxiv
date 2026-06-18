// PDF annotation toolbar: color, 4 tools, undo/redo.
// Tools: text/rect/draw are one-shot (set tool; PdfViewer resets to "none" after commit).
// highlight is a toggle (highlightOn).
import { useState } from "react";
import { useAnnotations, useCanUndo, useCanRedo } from "../store/annotations";
import { PALETTE } from "../lib/annotations";
import type { Tool } from "../types";

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

  const onTool = (t: Tool) => setTool(tool === t ? "none" : t);

  return (
    <div className="annot-toolbar">
      <div className="annot-color-wrap">
        <button
          className="annot-color-btn"
          title="Color"
          style={{ background: color }}
          onClick={() => setPaletteOpen((v) => !v)}
        />
        {paletteOpen && (
          <div className="annot-palette">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={"annot-swatch" + (c === color ? " selected" : "")}
                style={{ background: c }}
                onClick={() => {
                  setColor(c);
                  setPaletteOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <button
        className={"annot-tool-btn" + (tool === "text" ? " active" : "")}
        title="Text"
        onClick={() => onTool("text")}
      >📝</button>
      <button
        className={"annot-tool-btn" + (tool === "rect" ? " active" : "")}
        title="Rectangle"
        onClick={() => onTool("rect")}
      >▭</button>
      <button
        className={"annot-tool-btn" + (tool === "draw" ? " active" : "")}
        title="Freehand"
        onClick={() => onTool("draw")}
      >✏️</button>
      <button
        className={"annot-tool-btn" + (highlightOn ? " active" : "")}
        title="Highlight (toggle)"
        onClick={toggleHighlight}
      >🖍️</button>

      <span className="annot-sep" />
      <button
        className="annot-tool-btn"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={undo}
      >↶</button>
      <button
        className="annot-tool-btn"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={redo}
      >↷</button>
    </div>
  );
}
