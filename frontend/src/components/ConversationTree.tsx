import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../types";
import {
  collectConversationSubtreeIds,
  layoutConversationTree,
} from "../lib/conversationBranches";

interface TreeProps {
  nodes: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDeleteBranch?: (id: string) => Promise<void> | void;
  compact?: boolean;
}

function nodeLabel(node: Conversation, isRoot: boolean): string {
  if (isRoot) return node.title || "History root";
  return node.title || node.branch_excerpt || "Branch";
}

export function ConversationTree({
  nodes,
  activeId,
  onSelect,
  onDeleteBranch,
  compact = false,
}: TreeProps) {
  const layout = useMemo(() => layoutConversationTree(nodes), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const root = nodes.find((node) => !node.parent_id || !byId.has(node.parent_id)) ?? nodes[0];
  const [inspectedId, setInspectedId] = useState<string | null>(activeId ?? root?.id ?? null);

  useEffect(() => {
    if (activeId && byId.has(activeId)) {
      setInspectedId(activeId);
      return;
    }
    setInspectedId((current) => current && byId.has(current) ? current : root?.id ?? null);
  }, [activeId, byId, root?.id]);

  if (!root) return null;
  const inspected = byId.get(inspectedId ?? "") ?? byId.get(activeId ?? "") ?? root;
  const inspectedIsRoot = inspected.id === root.id;
  const subtreeSize = collectConversationSubtreeIds(nodes, inspected.id).length;

  return (
    <div className={`conversation-tree${compact ? " compact" : ""}`}>
      <div className="conversation-tree-scroll">
        <div
          className="conversation-tree-canvas"
          style={{ width: layout.width, height: layout.height }}
          aria-label={`${nodes.length} conversation node${nodes.length === 1 ? "" : "s"}`}
        >
          <svg
            className="conversation-tree-lines"
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
          >
            {layout.edges.map((edge) => {
              const middleY = (edge.fromY + edge.toY) / 2;
              return (
                <path
                  key={`${edge.parentId}-${edge.childId}`}
                  d={`M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${middleY}, ${edge.toX} ${middleY}, ${edge.toX} ${edge.toY}`}
                />
              );
            })}
          </svg>
          {layout.nodes.map((position) => {
            const node = byId.get(position.id)!;
            const isCurrent = node.id === activeId;
            const isInspected = node.id === inspected.id;
            const label = nodeLabel(node, node.id === root.id);
            return (
              <button
                key={node.id}
                type="button"
                className={`conversation-tree-node${isCurrent ? " current" : ""}${isInspected ? " inspected" : ""}`}
                style={{ left: position.x - 14, top: position.y - 14 }}
                aria-label={`${label}${isCurrent ? ", current node" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
                data-node-id={node.id}
                data-active={isCurrent ? "true" : "false"}
                title={label}
                onMouseEnter={() => setInspectedId(node.id)}
                onFocus={() => setInspectedId(node.id)}
                onClick={() => onSelect(node.id)}
              />
            );
          })}
        </div>
      </div>
      <div className="conversation-tree-detail" aria-live="polite">
        <div className="conversation-tree-detail-copy">
          <strong>{nodeLabel(inspected, inspectedIsRoot)}</strong>
          <span>
            {inspectedIsRoot
              ? "Root of this History"
              : inspected.branch_excerpt || "Conversation branch"}
          </span>
        </div>
        {!inspectedIsRoot && onDeleteBranch && (
          <button
            type="button"
            className="conversation-tree-delete"
            onClick={async () => {
              const suffix = subtreeSize > 1
                ? ` and its ${subtreeSize - 1} descendant${subtreeSize === 2 ? "" : "s"}`
                : "";
              if (!window.confirm(`Delete this branch${suffix}? This cannot be undone.`)) return;
              await onDeleteBranch(inspected.id);
            }}
          >
            Delete branch{subtreeSize > 1 ? ` (${subtreeSize})` : ""}
          </button>
        )}
      </div>
    </div>
  );
}

interface PopoverProps extends TreeProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

export function ConversationTreePopover({
  open,
  anchorRef,
  onClose,
  onPointerEnter,
  onPointerLeave,
  ...treeProps
}: PopoverProps) {
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 268;
      const estimatedHeight = Math.min(440, 146 + treeProps.nodes.length * 34);
      setPosition({
        left: Math.min(window.innerWidth - width - 8, rect.right + 8),
        top: Math.max(8, Math.min(rect.top - 16, window.innerHeight - estimatedHeight - 8)),
      });
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open, treeProps.nodes.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <section
      className="conversation-tree-popover"
      style={position}
      aria-label="History branches"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className="conversation-tree-popover-head">
        <div>
          <strong>History branches</strong>
          <span>{treeProps.nodes.length} node{treeProps.nodes.length === 1 ? "" : "s"}</span>
        </div>
        <button type="button" aria-label="Close History tree" onClick={onClose}>×</button>
      </div>
      <ConversationTree {...treeProps} compact />
    </section>,
    document.body,
  );
}
