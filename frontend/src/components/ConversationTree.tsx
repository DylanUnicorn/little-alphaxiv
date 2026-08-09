import {
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Conversation } from "../types";
import {
  collectConversationSubtreeIds,
  layoutConversationTree,
} from "../lib/conversationBranches";

interface TreeProps {
  nodes: Conversation[];
  activeId: string | null;
  generatingIds?: ReadonlySet<string>;
  completedIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onDeleteBranch?: (id: string) => Promise<void> | void;
  compact?: boolean;
  revealedNodeId?: string | null;
}

const NO_GENERATING_NODES: ReadonlySet<string> = new Set<string>();
const NO_COMPLETED_NODES: ReadonlySet<string> = new Set<string>();

function nodeLabel(node: Conversation, isRoot: boolean): string {
  if (isRoot) return node.title ? `History root: ${node.title}` : "History root";
  return node.title || node.branch_excerpt || "Branch";
}

export function ConversationTree({
  nodes,
  activeId,
  generatingIds = NO_GENERATING_NODES,
  completedIds = NO_COMPLETED_NODES,
  onSelect,
  onDeleteBranch,
  compact = false,
  revealedNodeId = null,
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
  const rootHasChildren = nodes.some((node) => node.parent_id === root.id);
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
                  className={edge.childId === revealedNodeId ? "revealed" : undefined}
                  d={`M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${middleY}, ${edge.toX} ${middleY}, ${edge.toX} ${edge.toY}`}
                  pathLength={1}
                  data-revealed={edge.childId === revealedNodeId ? "true" : "false"}
                />
              );
            })}
          </svg>
          {layout.nodes.map((position) => {
            const node = byId.get(position.id)!;
            const isCurrent = node.id === activeId;
            const isInspected = node.id === inspected.id;
            const isRoot = node.id === root.id;
            const isRevealed = node.id === revealedNodeId;
            const isGenerating = generatingIds.has(node.id);
            const isCompleted = !isGenerating && completedIds.has(node.id);
            const label = nodeLabel(node, isRoot);
            return (
              <button
                key={node.id}
                type="button"
                className={`conversation-tree-node${isRoot ? " root" : ""}${isRoot && !rootHasChildren ? " unbranched" : ""}${isCurrent ? " current" : ""}${isInspected ? " inspected" : ""}${isRevealed ? " revealed" : ""}${isGenerating ? " generating" : ""}${isCompleted ? " completed-unviewed" : ""}`}
                style={{ left: position.x - 14, top: position.y - 14 }}
                aria-label={`${label}${isCurrent ? ", current node" : ""}${isGenerating ? ", generating response" : ""}${isCompleted ? ", response ready, not viewed" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
                data-node-id={node.id}
                data-active={isCurrent ? "true" : "false"}
                data-root={isRoot ? "true" : "false"}
                data-has-children={isRoot ? (rootHasChildren ? "true" : "false") : undefined}
                data-revealed={isRevealed ? "true" : "false"}
                data-generating={isGenerating ? "true" : "false"}
                data-completed={isCompleted ? "true" : "false"}
                title={compact ? undefined : label}
                onMouseEnter={() => setInspectedId(node.id)}
                onFocus={() => setInspectedId(node.id)}
                onClick={() => onSelect(node.id)}
              >
                {isRoot && <span className="conversation-tree-root-marker" aria-hidden="true" />}
                {isGenerating && <span className="conversation-tree-node-spinner" aria-hidden="true" />}
                {isCompleted && <span className="conversation-tree-node-complete" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
      {!compact && (
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
      )}
    </div>
  );
}
