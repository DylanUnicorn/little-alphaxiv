import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../types";
import { layoutConversationTree } from "../lib/conversationBranches";
import {
  quickHistoryPopoverMetrics,
  type QuickHistoryPopoverMetrics,
} from "../lib/historyQuickTree";
import { ConversationTree } from "./ConversationTree";

interface Props {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement>;
  nodes: Conversation[];
  activeId: string | null;
  generatingIds?: ReadonlySet<string>;
  revealedNodeId?: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

const FALLBACK_METRICS: QuickHistoryPopoverMetrics = {
  left: 8,
  top: 56,
  width: 144,
  height: 64,
};

export function HistoryQuickTreePopover({
  open,
  anchorRef,
  nodes,
  activeId,
  generatingIds,
  revealedNodeId = null,
  onSelect,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: Props) {
  const layout = useMemo(() => layoutConversationTree(nodes), [nodes]);
  const [metrics, setMetrics] = useState(FALLBACK_METRICS);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      setMetrics(quickHistoryPopoverMetrics({
        anchor,
        tree: { width: layout.width, height: layout.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }));
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, layout.height, layout.width, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open || nodes.length === 0) return null;

  return createPortal(
    <nav
      className="history-quick-popover"
      aria-label="Quick conversation history"
      style={metrics}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <ConversationTree
        nodes={nodes}
        activeId={activeId}
        generatingIds={generatingIds}
        revealedNodeId={revealedNodeId}
        onSelect={onSelect}
        compact
      />
    </nav>,
    document.body,
  );
}
