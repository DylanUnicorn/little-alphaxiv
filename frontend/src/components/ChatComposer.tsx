import { useLayoutEffect, useRef, useEffect, useCallback } from "react";
import type { Attachment } from "../types";
import { computeTextareaHeight } from "../lib/chatComposer";
import { ModelSelectPill } from "./ModelSelectPill";
import { ContextRing } from "./ContextRing";

interface Props {
  value: string;
  onValueChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onAttach: () => void;
  busy: boolean;
  placeholder: string;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  models: { id: string }[];
  currentModel: string;
  onModelChange: (id: string) => void;
  conversationId: string;
  systemPrompt: string;
}

// 2-line minimum; cap = min(40vh, 240px). Both in px; the cap is resolved
// against the live viewport so a tall window allows ~8 lines.
const MIN_HEIGHT = 60;
const MAX_HEIGHT_VH = 40; // percent of viewport height
const MAX_HEIGHT_PX = 240;

function maxForViewport(): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return Math.min(MAX_HEIGHT_PX, Math.round((vh * MAX_HEIGHT_VH) / 100));
}

export function ChatComposer({
  value,
  onValueChange,
  onSend,
  onStop,
  onKeyDown,
  onPaste,
  onAttach,
  busy,
  placeholder,
  attachments,
  onRemoveAttachment,
  models,
  currentModel,
  onModelChange,
  conversationId,
  systemPrompt,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Re-measure on value change and on mount: shrink to auto first so a
  // deleted line lets the box collapse, then grow to scrollHeight (clamped).
  const measure = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = computeTextareaHeight(ta.scrollHeight, MIN_HEIGHT, maxForViewport());
    ta.style.height = `${next}px`;
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [value, measure]);

  // Re-measure when the column width changes (paper-view divider drag
  // reflows line wrapping) or the viewport height changes (cap depends on vh).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(ta);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const canSend = !busy && (value.trim().length > 0 || attachments.length > 0);

  return (
    <div className="chat-composer">
      <div className="chat-composer-input">
        <textarea
          ref={taRef}
          className="composer-textarea"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={2}
          disabled={busy}
        />
      </div>

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((att, i) => (
            <div key={i} className="composer-attachment">
              <img src={att.data_url} alt={att.name || "attachment"} />
              <button
                className="composer-attachment-remove"
                onClick={() => onRemoveAttachment(i)}
                title="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-composer-bar">
        <div className="chat-composer-bar-left">
          <button
            type="button"
            className="composer-icon-btn composer-attach-btn"
            title="Attach image"
            onClick={onAttach}
            disabled={busy}
          >
            {/* circle wrapping a logo */}
            <span className="composer-attach-glyph" aria-hidden>＋</span>
          </button>
          <ModelSelectPill
            models={models}
            value={currentModel}
            onChange={onModelChange}
            disabled={busy}
          />
        </div>
        <div className="chat-composer-bar-right">
          <ContextRing conversationId={conversationId} systemPrompt={systemPrompt} />
          <button
            type="button"
            className={`composer-icon-btn composer-send-btn${busy ? " is-stop" : ""}`}
            title={busy ? "Stop generating" : "Send (Enter)"}
            onClick={busy ? (onStop ?? (() => {})) : onSend}
            disabled={busy ? false : !canSend}
          >
            {/* arrow = send, square = stop (visible while assistant is replying) */}
            <span className="composer-send-glyph" aria-hidden>{busy ? "■" : "➤"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
