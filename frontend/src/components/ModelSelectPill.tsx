import { useState, useRef, useEffect, useCallback } from "react";

interface Props {
  models: { id: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/** Custom dropdown capsule showing the current model id with a ▾.
 *  Click opens a list; the current model is checked ✓. Closes on
 *  outside-click or Escape. Keyboard: ↑/↓ moves the highlight, Enter
 *  selects, Escape closes. Falls back to a text <input> when the model
 *  list is empty (parity with the old native-select behavior for
 *  providers that expose no model list). */
export function ModelSelectPill({ models, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Reset highlight to the current model whenever the list opens.
  useEffect(() => {
    if (open) {
      const idx = models.findIndex((m) => m.id === value);
      setHighlight(idx >= 0 ? idx : 0);
    }
  }, [open, models, value]);

  const choose = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange]
  );

  function onKey(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(models.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = models[highlight];
      if (m) choose(m.id);
    }
  }

  // Empty list → text input (parity with old behavior).
  if (models.length === 0) {
    return (
      <input
        className="model-pill-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model id"
        title="Model for this conversation"
        disabled={disabled}
      />
    );
  }

  return (
    <div className="model-pill" ref={wrapRef}>
      <button
        type="button"
        className="model-pill-btn"
        title="Select model for this conversation"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKey}
        disabled={disabled}
      >
        <span className="model-pill-name">{value || "model"}</span>
        <span className="model-pill-caret">▾</span>
      </button>
      {open && (
        <ul className="model-pill-list" role="listbox">
          {models.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={m.id === value}
              className={`model-pill-item ${i === highlight ? "highlighted" : ""} ${
                m.id === value ? "selected" : ""
              }`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(m.id)}
            >
              <span className="model-pill-check">{m.id === value ? "✓" : ""}</span>
              <span className="model-pill-id">{m.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
