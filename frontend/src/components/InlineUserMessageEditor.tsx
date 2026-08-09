import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Attachment } from "../types";

export interface InlineMessageDraft {
  text: string;
  attachments: Attachment[];
}

interface Props {
  initialText: string;
  initialAttachments: Attachment[];
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (draft: InlineMessageDraft) => Promise<void> | void;
}

export function shouldCancelInlineEdit(
  container: Pick<Node, "contains"> | null,
  target: EventTarget | null,
  submitting: boolean,
) {
  if (submitting) return false;
  return !target || !container?.contains(target as Node);
}

export function InlineUserMessageEditor({
  initialText,
  initialAttachments,
  submitting,
  onCancel,
  onSubmit,
}: Props) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState(() => [...initialAttachments]);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onCancelRef = useRef(onCancel);
  const submittingRef = useRef(submitting);
  onCancelRef.current = onCancel;
  submittingRef.current = submitting;

  function resizeTextarea() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Install outside-interaction listeners after the activation click has
    // finished, so the Edit click cannot cancel the editor it just opened.
    const cancelFromOutside = (event: Event) => {
      if (!shouldCancelInlineEdit(containerRef.current, event.target, submittingRef.current)) return;
      onCancelRef.current();
    };
    const focusTimer = window.setTimeout(() => {
      resizeTextarea();
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      document.addEventListener("pointerdown", cancelFromOutside, true);
      document.addEventListener("focusin", cancelFromOutside, true);
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", cancelFromOutside, true);
      document.removeEventListener("focusin", cancelFromOutside, true);
    };
  }, []);

  useEffect(resizeTextarea, [text]);

  const canSubmit = text.trim().length > 0 || attachments.length > 0;

  async function submit() {
    if (!canSubmit || submitting) return;
    await onSubmit({ text, attachments });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!submitting) onCancel();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div ref={containerRef} className="inline-message-editor">
      <textarea
        ref={textareaRef}
        aria-label="Edit message"
        value={text}
        disabled={submitting}
        rows={1}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {attachments.length > 0 && (
        <div className="inline-message-editor-attachments">
          {attachments.map((attachment, index) => (
            <div className="inline-message-editor-attachment" key={`${attachment.data_url}-${index}`}>
              <img src={attachment.data_url} alt={attachment.name || "attachment"} />
              <button
                type="button"
                aria-label="Remove attachment"
                disabled={submitting}
                onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="inline-message-editor-actions">
        <span className="inline-message-editor-hint">Ctrl/⌘ + Enter to resend</span>
        <button type="button" className="inline-message-editor-cancel" disabled={submitting} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="inline-message-editor-submit"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
        >
          {submitting ? "Sending…" : "Resend"}
        </button>
      </div>
    </div>
  );
}
