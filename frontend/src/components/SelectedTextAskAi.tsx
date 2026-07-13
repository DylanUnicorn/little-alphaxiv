import { useEffect, useState } from "react";
import {
  findSelectedPdfPage,
  selectedPdfTextPayload,
  visibleSelectedTextPayload,
  type SelectedPdfTextPayload,
} from "../lib/selectedTextAskAi";

interface Props {
  disabled: boolean;
  onAsk: (context: SelectedPdfTextPayload) => void;
}

interface PendingSelection extends SelectedPdfTextPayload {
  left: number;
  top: number;
}

function elementForNode(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

export function SelectedTextAskAi({ disabled, onAsk }: Props) {
  const [pending, setPending] = useState<PendingSelection | null>(null);

  useEffect(() => {
    if (disabled) setPending(null);
  }, [disabled]);

  useEffect(() => {
    function dismiss() {
      setPending(null);
    }

    function onMouseUp() {
      if (disabled) {
        dismiss();
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        dismiss();
        return;
      }

      const range = selection.getRangeAt(0);
      const start = elementForNode(range.startContainer);
      const end = elementForNode(range.endContainer);
      if (!start || !end) {
        dismiss();
        return;
      }

      const payload = selectedPdfTextPayload(
        selection.toString(),
        findSelectedPdfPage(start),
        findSelectedPdfPage(end),
      );
      const rect = range.getBoundingClientRect();
      if (!payload || (!rect.width && !rect.height)) {
        dismiss();
        return;
      }

      setPending({
        ...payload,
        left: Math.max(8, rect.right),
        top: Math.max(8, rect.top - 34),
      });
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest(".selected-text-ask-ai")) return;
      dismiss();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      window.getSelection()?.removeAllRanges();
      dismiss();
    }

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [disabled]);

  const visiblePending = visibleSelectedTextPayload(pending, disabled);
  if (!visiblePending) return null;

  return (
    <button
      type="button"
      className="selected-text-ask-ai"
      style={{ left: visiblePending.left, top: visiblePending.top }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={() => {
        if (disabled) return;
        onAsk({ text: visiblePending.text, pageNumber: visiblePending.pageNumber });
        window.getSelection()?.removeAllRanges();
        setPending(null);
      }}
    >
      Ask AI
    </button>
  );
}
