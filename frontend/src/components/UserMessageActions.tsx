import { useEffect, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";

interface Props {
  text: string;
  editDisabled: boolean;
  onEdit: () => void;
}

type CopyState = "idle" | "copied" | "failed";

export function UserMessageActions({ text, editDisabled, onEdit }: Props) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function copyMessage() {
    if (!navigator.clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 1500);
  }

  const copyLabel = copyState === "copied"
    ? "Message copied"
    : copyState === "failed"
      ? "Could not copy message"
      : "Copy message";

  return (
    <div className="user-message-actions" role="group" aria-label="Message actions">
      <Tooltip label={copyLabel} side="bottom">
        <button
          type="button"
          className={`user-message-action${copyState === "copied" ? " is-copied" : ""}`}
          aria-label={copyLabel}
          onClick={() => void copyMessage()}
        >
          {copyState === "copied" ? (
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <path d="m3.5 9.5 3.2 3.2 7.8-8" />
            </svg>
          ) : (
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <rect x="6.25" y="5.25" width="8" height="9" rx="1.6" />
              <path d="M4 12.75H3.5A1.5 1.5 0 0 1 2 11.25v-7.5A1.5 1.5 0 0 1 3.5 2.25h7A1.5 1.5 0 0 1 12 3.75V4" />
            </svg>
          )}
        </button>
      </Tooltip>
      <Tooltip label="Edit message" side="bottom" showWhenDisabled>
        <button
          type="button"
          className="user-message-action"
          aria-label="Edit message"
          disabled={editDisabled}
          onClick={onEdit}
        >
          <svg viewBox="0 0 18 18" aria-hidden="true">
            <path d="M3 15h3.1L14.7 6.4a1.7 1.7 0 0 0-2.4-2.4l-8.6 8.6L3 15Z" />
            <path d="m10.9 5.4 2.4 2.4" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
