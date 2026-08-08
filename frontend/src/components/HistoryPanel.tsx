// Paper-view History management. Each explicit "New conversation" is one
// root; selection-created conversations render beneath it as a branch tree.

import { useConversations } from "../store/conversations";
import { useChatRuntime } from "../store/chatRuntime";
import type { Conversation } from "../types";
import {
  collectConversationSubtreeIds,
  groupConversationHistories,
} from "../lib/conversationBranches";
import { ConversationTree } from "./ConversationTree";
import { Tooltip } from "./Tooltip";

interface Props {
  arxivId: string;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function threadTitle(conversation: Conversation): string {
  if (
    conversation.title
    && conversation.title !== "Paper discussion"
    && !conversation.title.startsWith("📄")
  ) {
    return conversation.title;
  }
  return conversation.messages.length === 0 ? "New discussion" : "Untitled discussion";
}

export function HistoryPanel({ arxivId, activeId, onSelect, onNew, onClose }: Props) {
  const conversations = useConversations((state) => state.conversations);
  const remove = useConversations((state) => state.remove);
  const generatingIds = useChatRuntime((state) => state.generatingIds);
  const threads = conversations.filter(
    (conversation) => conversation.type === "paper" && conversation.paper_id === arxivId,
  );
  const histories = groupConversationHistories(threads);

  async function deleteBranch(id: string) {
    const history = histories.find((candidate) => candidate.nodes.some((node) => node.id === id));
    if (!history) return;
    const deletedIds = new Set(collectConversationSubtreeIds(history.nodes, id));
    const activeWasDeleted = activeId ? deletedIds.has(activeId) : false;
    const parentId = history.nodes.find((node) => node.id === id)?.parent_id;
    await remove(id);
    if (!activeWasDeleted) return;
    const fallback = parentId && !deletedIds.has(parentId)
      ? history.nodes.find((node) => node.id === parentId)
      : histories
          .flatMap((candidate) => candidate.nodes)
          .filter((node) => !deletedIds.has(node.id))
          .sort((a, b) => b.updated_at - a.updated_at)[0];
    if (fallback) onSelect(fallback.id);
    else onNew();
  }

  async function deleteHistory(rootId: string) {
    const history = histories.find((candidate) => candidate.root.id === rootId);
    if (!history) return;
    const activeWasDeleted = activeId
      ? history.nodes.some((node) => node.id === activeId)
      : false;
    const count = history.nodes.length;
    const prompt = count > 1
      ? `Delete this entire History and all ${count} nodes? This cannot be undone.`
      : "Delete this conversation? This cannot be undone.";
    if (!window.confirm(prompt)) return;
    await remove(rootId);
    if (!activeWasDeleted) return;
    const fallback = histories
      .filter((candidate) => candidate.root.id !== rootId)
      .flatMap((candidate) => candidate.nodes)
      .sort((a, b) => b.updated_at - a.updated_at)[0];
    if (fallback) onSelect(fallback.id);
    else onNew();
  }

  return (
    <div className="history-panel">
      <div className="history-head">
        <span className="history-title">History</span>
        <Tooltip label="New root conversation" side="bottom">
          <button className="history-new" onClick={onNew}>✚ New</button>
        </Tooltip>
        <Tooltip label="Close" side="bottom">
          <button className="history-close" onClick={onClose}>✕</button>
        </Tooltip>
      </div>
      <div className="history-list history-tree-list">
        {histories.length === 0 && (
          <div className="history-empty">No conversations for this paper yet.</div>
        )}
        {histories.map((history) => {
          const active = history.nodes.some((node) => node.id === activeId);
          return (
            <section
              key={history.id}
              className={`history-tree-group${active ? " active" : ""}`}
            >
              <div className="history-tree-group-head">
                <button
                  type="button"
                  className="history-tree-group-copy"
                  onClick={() => onSelect(history.representative.id)}
                >
                  <strong>{threadTitle(history.root)}</strong>
                  <span>
                    {history.nodes.length} node{history.nodes.length === 1 ? "" : "s"}
                    {" · "}{relativeTime(history.updatedAt)}
                  </span>
                </button>
                <Tooltip label="Delete entire History" side="top">
                  <button
                    type="button"
                    className="history-item-del"
                    onClick={() => deleteHistory(history.root.id)}
                  >×</button>
                </Tooltip>
              </div>
              <ConversationTree
                nodes={history.nodes}
                activeId={activeId}
                generatingIds={generatingIds}
                onSelect={onSelect}
                onDeleteBranch={deleteBranch}
              />
            </section>
          );
        })}
      </div>
    </div>
  );
}
