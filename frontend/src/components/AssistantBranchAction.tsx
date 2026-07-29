import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { normalizeBranchExcerpt } from "../lib/conversationBranches";

interface Props {
  messageIndex: number;
  disabled: boolean;
  onBranch: (messageIndex: number, excerpt: string) => Promise<void>;
  children: ReactNode;
}

interface PendingSelection {
  excerpt: string;
  left: number;
  top: number;
}

export function AssistantBranchAction({
  messageIndex,
  disabled,
  onBranch,
  children,
}: Props) {
  const messageRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (disabled) setPending(null);
  }, [disabled]);

  useEffect(() => {
    if (!pending) return;
    const dismiss = (event?: Event) => {
      const target = event?.target;
      if (target instanceof Element && target.closest(".assistant-branch-action")) return;
      setPending(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      window.getSelection()?.removeAllRanges();
      setPending(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [pending]);

  function captureSelection() {
    if (disabled || creating) {
      setPending(null);
      return;
    }
    const selection = window.getSelection();
    const host = messageRef.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !host) {
      setPending(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) {
      setPending(null);
      return;
    }
    const excerpt = normalizeBranchExcerpt(selection.toString());
    const rect = range.getBoundingClientRect();
    if (!excerpt || (!rect.width && !rect.height)) {
      setPending(null);
      return;
    }
    const buttonWidth = 94;
    setPending({
      excerpt,
      left: Math.min(window.innerWidth - buttonWidth - 8, Math.max(8, rect.right + 8)),
      top: Math.max(8, rect.top - 38),
    });
  }

  return (
    <>
      <div
        ref={messageRef}
        className="msg msg-assistant"
        data-message-index={messageIndex}
        onMouseUp={captureSelection}
      >
        {children}
      </div>
      {pending && createPortal(
        <button
          type="button"
          className="assistant-branch-action"
          style={{ left: pending.left, top: pending.top }}
          aria-label="Create a branch from selected assistant text"
          title="Start a branch from selected text"
          disabled={creating || disabled}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={async () => {
            if (creating || disabled) return;
            setCreating(true);
            try {
              await onBranch(messageIndex, pending.excerpt);
              window.getSelection()?.removeAllRanges();
              setPending(null);
            } catch {
              // ChatPanel surfaces the persistence error. Keep the selection
              // action open so the user can retry without selecting again.
            } finally {
              setCreating(false);
            }
          }}
        >
          <svg className="assistant-branch-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3v3.25c0 1.1.9 2 2 2h2c1.1 0 2 .9 2 2V13M5 8.25V13" />
            <circle cx="5" cy="2.5" r="1.5" />
            <circle cx="5" cy="13.5" r="1.5" />
            <circle cx="11" cy="13.5" r="1.5" />
          </svg>
          <span>{creating ? "Creating" : "Branch"}</span>
        </button>,
        document.body,
      )}
    </>
  );
}
