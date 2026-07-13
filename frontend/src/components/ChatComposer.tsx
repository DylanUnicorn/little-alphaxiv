import { useLayoutEffect, useRef, useEffect, useCallback, useState } from "react";
import type { Attachment } from "../types";
import { canSubmitComposer, computeTextareaHeight, pickImageFiles } from "../lib/chatComposer";
import type { SelectedPdfTextPayload } from "../lib/selectedTextAskAi";
import { useSettings } from "../store/settings";
import { ModelSelectPill } from "./ModelSelectPill";
import { ContextRing } from "./ContextRing";
import { Tooltip } from "./Tooltip";

interface Props {
  value: string;
  onValueChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onAttach: () => void;
  onDropFiles: (files: File[]) => void;
  busy: boolean;
  placeholder: string;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  selectedTextContext?: SelectedPdfTextPayload | null;
  onRemoveSelectedText?: () => void;
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
  onDropFiles,
  busy,
  placeholder,
  attachments,
  onRemoveAttachment,
  selectedTextContext,
  onRemoveSelectedText,
  models,
  currentModel,
  onModelChange,
  conversationId,
  systemPrompt,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const anysearch = useSettings((s) => s.searchSources.anysearch);
  const setSearchSources = useSettings((s) => s.setSearchSources);

  // Drag-and-drop state. dragCounter ref solves the nested-element flicker:
  // dragenter on a child fires before dragleave on the parent, so counting
  // enters/leaves and clearing the overlay only at zero avoids strobing as
  // the cursor crosses the textarea / previews / bar children.
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const [rejectToast, setRejectToast] = useState<string | null>(null);
  const rejectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel any pending reject-toast timer on unmount.
  useEffect(() => {
    return () => {
      if (rejectTimer.current) clearTimeout(rejectTimer.current);
    };
  }, []);

  // Reset the drag overlay if the drop ends OUTSIDE the composer (e.g. released
  // on the message list or out of the window), where onDrop never fires and the
  // dragCounter would otherwise stay > 0 and leave the overlay stuck. When the
  // drop is on the composer, onDrop already resets to 0, so these are no-ops.
  useEffect(() => {
    const reset = () => {
      dragCounter.current = 0;
      setDragOver(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

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

  useEffect(() => {
    if (selectedTextContext) taRef.current?.focus();
  }, [selectedTextContext]);

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

  // Only treat drags carrying real files as drop candidates; ignore text/link
  // drags so normal in-textarea drag-drop of selections is unaffected.
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // required to permit the drop
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const { images, rejected } = pickImageFiles(files);
      if (images.length > 0) onDropFiles(images);
      if (rejected.length > 0) {
        // Restart the timer so back-to-back rejects show one steady toast.
        if (rejectTimer.current) clearTimeout(rejectTimer.current);
        setRejectToast("仅支持图片");
        rejectTimer.current = setTimeout(() => {
          setRejectToast(null);
          rejectTimer.current = null;
        }, 2500);
      }
    },
    [onDropFiles]
  );

  const canSend = canSubmitComposer(
    value,
    attachments.length,
    !!selectedTextContext,
    busy,
  );

  return (
    <div
      className={`chat-composer${dragOver ? " drag-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="chat-composer-drop-overlay" aria-hidden>
          <span>⬇ 松开以添加图片</span>
        </div>
      )}
      {selectedTextContext && (
        <div className="composer-selected-text">
          <div className="composer-selected-text-copy">
            <strong>Page {selectedTextContext.pageNumber}:</strong>
            <span>{selectedTextContext.text}</span>
          </div>
          <button
            type="button"
            className="composer-selected-text-remove"
            aria-label="Remove selected text"
            title="Remove selected text"
            onClick={onRemoveSelectedText}
            disabled={busy}
          >
            ×
          </button>
        </div>
      )}
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
                aria-label="Remove attachment"
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
          <ModelSelectPill
            models={models}
            value={currentModel}
            onChange={onModelChange}
            disabled={busy}
          />
          <Tooltip label={anysearch.enabled ? "Disable web search" : "Enable web search"} side="top">
            <button
              type="button"
              className={`composer-search-pill${anysearch.enabled ? " active" : ""}`}
              onClick={() => setSearchSources({ anysearch: { ...anysearch, enabled: !anysearch.enabled } })}
              aria-pressed={anysearch.enabled}
              disabled={busy}
            >
              <span className="composer-search-icon" aria-hidden>◎</span>
              <span>Search</span>
            </button>
          </Tooltip>
          <Tooltip label="Attach image" side="top">
            <button
              type="button"
              className="composer-icon-btn composer-attach-btn"
              onClick={onAttach}
              disabled={busy}
            >
              <span className="composer-attach-glyph" aria-hidden>＋</span>
            </button>
          </Tooltip>
        </div>
        <div className="chat-composer-bar-right">
          <ContextRing conversationId={conversationId} systemPrompt={systemPrompt} />
          <Tooltip label={busy ? "Stop generating" : "Send (Enter)"} side="top">
            <button
              type="button"
              className={`composer-icon-btn composer-send-btn${busy ? " is-stop" : ""}`}
              onClick={busy ? (onStop ?? (() => {})) : onSend}
              disabled={busy ? false : !canSend}
            >
              <span className="composer-send-glyph" aria-hidden>{busy ? "■" : "↑"}</span>
            </button>
          </Tooltip>
        </div>
      </div>
      {rejectToast && (
        <div className="chat-composer-reject-toast" role="status">
          {rejectToast}
        </div>
      )}
    </div>
  );
}
