import { useRef, useEffect, useCallback, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { MathfieldElement } from "mathlive";
import type { Attachment } from "../types";
import { canSubmitComposer, pickImageFiles } from "../lib/chatComposer";
import {
  composerDocumentToInlineContent,
  composerDocumentToMarkdown,
  markdownToComposerDocument,
} from "../lib/composerDocument";
import { useSettings } from "../store/settings";
import { ModelSelectPill } from "./ModelSelectPill";
import { ContextRing } from "./ContextRing";
import { Tooltip } from "./Tooltip";
import { MathNodeExtension } from "./composer/mathNodeExtension";

interface Props {
  value: string;
  onValueChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  onPaste: (e: ClipboardEvent) => void;
  onAttach: () => void;
  onDropFiles: (files: File[]) => void;
  busy: boolean;
  placeholder: string;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  selectedTextContext?: { text: string; label: string } | null;
  onRemoveSelectedText?: () => void;
  models: { id: string }[];
  currentModel: string;
  onModelChange: (id: string) => void;
  conversationId: string;
  systemPrompt: string;
}

export function ChatComposer({
  value,
  onValueChange,
  onSend,
  onStop,
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
  const inputRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const valueRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  const onSendRef = useRef(onSend);
  const onPasteRef = useRef(onPaste);
  const [isEditorEmpty, setIsEditorEmpty] = useState(value.length === 0);
  const anysearch = useSettings((s) => s.searchSources.anysearch);
  const setSearchSources = useSettings((s) => s.setSearchSources);

  valueRef.current = value;
  onValueChangeRef.current = onValueChange;
  onSendRef.current = onSend;
  onPasteRef.current = onPaste;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        listItem: false,
        orderedList: false,
        strike: false,
      }),
      MathNodeExtension,
    ],
    content: markdownToComposerDocument(value),
    editable: !busy,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": "Message",
        "aria-multiline": "true",
        role: "textbox",
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
        event.preventDefault();
        onSendRef.current();
        return true;
      },
      handlePaste: (_view, event) => {
        onPasteRef.current(event);
        if (event.defaultPrevented) return true;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text) return false;
        const content = composerDocumentToInlineContent(text);
        if (!content.some((node) => node.type === "math")) return false;
        event.preventDefault();
        editorRef.current?.commands.insertContent(content);
        return true;
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      const nextValue = composerDocumentToMarkdown(updatedEditor.getJSON());
      setIsEditorEmpty(nextValue.length === 0);
      if (nextValue === valueRef.current) return;
      valueRef.current = nextValue;
      onValueChangeRef.current(nextValue);
    },
  });
  editorRef.current = editor;

  // Keep the Tiptap document synchronized with the controlled string without
  // replacing the document (and therefore the caret) for our own updates.
  useEffect(() => {
    if (!editor) return;
    const currentValue = composerDocumentToMarkdown(editor.getJSON());
    if (currentValue === value) return;
    valueRef.current = value;
    editor.commands.setContent(markdownToComposerDocument(value), { emitUpdate: false });
    setIsEditorEmpty(value.length === 0);
  }, [editor, value, conversationId]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!busy);
    inputRef.current?.querySelectorAll<MathfieldElement>("math-field").forEach((field) => {
      field.readOnly = busy;
    });
  }, [busy, editor]);

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

  useEffect(() => {
    if (selectedTextContext) editor?.commands.focus("end");
  }, [editor, selectedTextContext]);

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
            <strong>{selectedTextContext.label}:</strong>
            <span>{selectedTextContext.text}</span>
          </div>
          {onRemoveSelectedText && (
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
          )}
        </div>
      )}
      <div
        ref={inputRef}
        className={`chat-composer-input composer-rich-input${busy ? " is-disabled" : ""}`}
        onClick={(event) => {
          if (!busy && event.target === event.currentTarget) editor?.commands.focus("end");
        }}
      >
        {isEditorEmpty && (
          <span className="composer-placeholder" aria-hidden="true">{placeholder}</span>
        )}
        <EditorContent editor={editor} className="composer-editor" />
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
