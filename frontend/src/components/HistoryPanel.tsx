// History panel for the paper view's right column. Replaces the crude dropdown
// list with a proper conversation-management surface: each of the paper's
// threads is listed by the user's first question (so you can tell them apart),
// with relative time, message count, delete, and a prominent "New" button.

import { useConversations } from "../store/conversations";
import type { Conversation } from "../types";
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
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function threadTitle(c: Conversation): string {
  if (c.title && c.title !== "Paper discussion" && !c.title.startsWith("📄")) {
    return c.title;
  }
  return c.messages.length === 0 ? "New discussion" : "Untitled discussion";
}

export function HistoryPanel({ arxivId, activeId, onSelect, onNew, onClose }: Props) {
  const conversations = useConversations((s) => s.conversations);
  const remove = useConversations((s) => s.remove);

  const threads = conversations
    .filter((c) => c.type === "paper" && c.paper_id === arxivId)
    .sort((a, b) => b.updated_at - a.updated_at);

  async function handleDelete(id: string) {
    const wasActive = id === activeId;
    const remaining = threads.filter((t) => t.id !== id);
    await remove(id);
    if (wasActive) {
      if (remaining[0]) onSelect(remaining[0].id);
      else onNew();
    }
  }

  return (
    <div className="history-panel">
      <div className="history-head">
        <span className="history-title">Conversations</span>
        <Tooltip label="New conversation" side="bottom">
          <button className="history-new" onClick={onNew}>✚ New</button>
        </Tooltip>
        <Tooltip label="Close" side="bottom">
          <button className="history-close" onClick={onClose}>✕</button>
        </Tooltip>
      </div>
      <div className="history-list">
        {threads.length === 0 && (
          <div className="history-empty">No conversations for this paper yet.</div>
        )}
        {threads.map((c) => (
          <div
            key={c.id}
            className={`history-item ${c.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(c.id)}
          >
            <div className="history-item-main">
              <div className="history-item-title">{threadTitle(c)}</div>
              <div className="history-item-meta">
                {c.messages.length} msg · {relativeTime(c.updated_at)}
              </div>
            </div>
            <Tooltip label="Delete" side="top">
              <button
                className="history-item-del"
                onClick={(e) => { e.stopPropagation(); handleDelete(c.id); }}
              >×</button>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
}
