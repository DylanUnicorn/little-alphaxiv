// Left sidebar: new-chat button + conversation list + settings link.
// Supports a collapsed mode (thin icon strip) used in the paper view to give
// the PDF more room. Click the expand button or the new-chat icon to reopen.
//
// Conversation list layout:
//   - General chats: one entry each, titled by an LLM summary of the first
//     exchange (falls back to the truncated first question if the model is
//     unavailable — see ChatPanel.maybeSummarizeTitle).
//   - Paper chats: GROUPED by paper_id into a single entry per paper (the
//     paper's threads are managed inside the paper view's history panel, not
//     spammed here). The entry is titled by the most-recent thread's title so
//     the user can trace back what each entry is about.
//   - Entries are grouped under alphaxiv-style date headers (Today / Yesterday
//     / Previous 7 Days / Previous 30 Days / <Month Year>) via groupByDate.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { THEMES } from "../themes";
import { groupByDate } from "../lib/dates";
import * as db from "../lib/db";
import { hasRealTitle } from "../lib/paperMeta";
import type { Conversation } from "../types";
import { Tooltip } from "./Tooltip";
import {
  collectConversationSubtreeIds,
  groupConversationHistories,
  type ConversationHistory,
} from "../lib/conversationBranches";
import { ConversationTreePopover } from "./ConversationTree";

type Item =
  | { kind: "general"; history: ConversationHistory }
  | { kind: "paper"; paperId: string; threads: Conversation[]; rep: Conversation };

/** Timestamp used to bucket a sidebar item into a date group. */
function itemTs(it: Item): number {
  return it.kind === "general" ? it.history.updatedAt : it.rep.updated_at;
}

/** Sidebar label for a paper group: prefer the paper's real cached title (looked
 *  up from the paper cache so a row created before this fix — titled
 *  `📄 sha256:…` — heals without waiting for the user to ask a question), then
 *  the most-recent thread's real title, then the `📄 <id>` fallback. */
function paperGroupLabel(
  paperId: string,
  cachedTitle: string | undefined,
  rep: Conversation,
): string {
  if (cachedTitle && hasRealTitle({ title: cachedTitle }, paperId)) return cachedTitle;
  const t = rep.title;
  if (t && t !== "Paper discussion" && !t.startsWith("📄")) return t;
  return `📄 ${paperId}`;
}

function GeneralHistoryRow({
  history,
  activeId,
  onSelect,
  onRemove,
}: {
  history: ConversationHistory;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const active = history.nodes.some((node) => node.id === activeId);

  function openTree() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setTreeOpen(true);
  }

  function scheduleClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setTreeOpen(false);
      closeTimer.current = null;
    }, 140);
  }

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  async function deleteBranch(id: string) {
    const deletedIds = new Set(collectConversationSubtreeIds(history.nodes, id));
    const activeWasDeleted = activeId ? deletedIds.has(activeId) : false;
    const parentId = history.nodes.find((node) => node.id === id)?.parent_id;
    await onRemove(id);
    if (!activeWasDeleted) return;
    const fallback = parentId && !deletedIds.has(parentId)
      ? history.nodes.find((node) => node.id === parentId)
      : history.nodes
          .filter((node) => !deletedIds.has(node.id))
          .sort((a, b) => b.updated_at - a.updated_at)[0];
    if (fallback) {
      setTreeOpen(false);
      onSelect(fallback.id);
    }
  }

  return (
    <>
      <div
        ref={rowRef}
        className={`conv-item ${active ? "active" : ""}`}
        role="group"
        aria-label={`History: ${history.root.title || "New chat"}`}
        onMouseEnter={openTree}
        onMouseLeave={scheduleClose}
        onFocus={openTree}
      >
        <button
          type="button"
          className="conv-item-main"
          aria-label={`Open History: ${history.root.title || "New chat"}`}
          onClick={() => onSelect(history.representative.id)}
        >
          <span className="conv-tag">💬</span>
          <span className="conv-title">{history.root.title || "New chat"}</span>
          {history.nodes.length > 1 && <span className="conv-count">{history.nodes.length}</span>}
        </button>
        <button
          type="button"
          className="conv-tree-open"
          aria-label="Show History tree"
          aria-expanded={treeOpen}
          onClick={(event) => {
            event.stopPropagation();
            setTreeOpen((open) => !open);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3v3c0 1.1.9 2 2 2h2c1.1 0 2 .9 2 2v3M5 8v5" />
            <circle cx="5" cy="2.5" r="1.5" />
            <circle cx="5" cy="13.5" r="1.5" />
            <circle cx="11" cy="13.5" r="1.5" />
          </svg>
        </button>
        <Tooltip label={history.nodes.length > 1 ? "Delete entire History" : "Delete"} side="top">
          <button
            type="button"
            className="conv-del"
            onClick={async (event) => {
              event.stopPropagation();
              const count = history.nodes.length;
              const message = count > 1
                ? `Delete this entire History and all ${count} nodes? This cannot be undone.`
                : "Delete this conversation? This cannot be undone.";
              if (!window.confirm(message)) return;
              setTreeOpen(false);
              await onRemove(history.root.id);
            }}
          >×</button>
        </Tooltip>
      </div>
      <ConversationTreePopover
        open={treeOpen}
        anchorRef={rowRef}
        nodes={history.nodes}
        activeId={activeId}
        onSelect={(id) => {
          setTreeOpen(false);
          onSelect(id);
        }}
        onDeleteBranch={deleteBranch}
        onClose={() => setTreeOpen(false)}
        onPointerEnter={openTree}
        onPointerLeave={scheduleClose}
      />
    </>
  );
}

export function Sidebar() {
  const navigate = useNavigate();
  const conversations = useConversations((s) => s.conversations);
  const activeId = useConversations((s) => s.activeId);
  const setActive = useConversations((s) => s.setActive);
  const create = useConversations((s) => s.create);
  const remove = useConversations((s) => s.remove);
  const removeMany = useConversations((s) => s.removeMany);
  const providers = useSettings((s) => s.providers);
  const defaultProviderId = useSettings((s) => s.defaultProviderId);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const collapse = useUi((s) => s.collapseSidebar);
  const expand = useUi((s) => s.expandSidebar);
  const openLocalPaper = useUi((s) => s.openLocalPaperDialog);

  async function newChat() {
    // Reuse an existing empty general chat instead of stacking empties.
    const c = await create({
      type: "general",
      reuseEmpty: true,
      providerId: defaultProviderId ?? undefined,
    });
    setActive(c.id);
    navigate(`/chat/${c.id}`);
  }

  // Build sidebar items: one row per general History root + paper groups.
  const items: Item[] = [];
  const paperGroups = new Map<string, Conversation[]>();
  for (const c of conversations) {
    if (c.type === "paper" && c.paper_id) {
      const arr = paperGroups.get(c.paper_id) ?? [];
      arr.push(c);
      paperGroups.set(c.paper_id, arr);
    }
  }
  for (const history of groupConversationHistories(
    conversations.filter((conversation) => conversation.type === "general"),
  )) {
    items.push({ kind: "general", history });
  }
  for (const [paperId, threads] of paperGroups) {
    const rep = threads.slice().sort((a, b) => b.updated_at - a.updated_at)[0];
    items.push({ kind: "paper", paperId, threads, rep });
  }
  // Most-recently-touched first.
  items.sort((a, b) => {
    const ta = a.kind === "general" ? a.history.updatedAt : a.rep.updated_at;
    const tb = b.kind === "general" ? b.history.updatedAt : b.rep.updated_at;
    return tb - ta;
  });
  // Bucket into alphaxiv-style date groups (items are already MRU, so each
  // group's internal order is preserved).
  const grouped = groupByDate(items, itemTs);

  // Resolve each paper group's real title from the paper cache (so a row titled
  // `📄 sha256:…` from before this fix heals to the paper's actual title).
  const paperIdKey = Array.from(paperGroups.keys()).sort().join("\n");
  const [paperTitles, setPaperTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    const ids = paperIdKey ? paperIdKey.split("\n") : [];
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        ids.map(async (id): Promise<[string, string]> => {
          try {
            const p = await db.getPaper(id);
            return [id, p?.title ?? ""];
          } catch {
            return [id, ""];
          }
        }),
      );
      if (cancelled) return;
      setPaperTitles((prev) => {
        const next = { ...prev };
        for (const [id, t] of entries) if (t) next[id] = t;
        return next;
      });
    })();
    return () => { cancelled = true; };
    // paperIdKey is a stable string snapshot of the current paper-id set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperIdKey]);

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <Tooltip label="Expand sidebar" side="right">
          <button className="icon-btn" onClick={expand}>»</button>
        </Tooltip>
        <Tooltip label="New chat" side="right">
          <button className="icon-btn" onClick={newChat}>+</button>
        </Tooltip>
        <Tooltip label="Open Paper" side="right">
          <button className="icon-btn" onClick={() => openLocalPaper()}>📄</button>
        </Tooltip>
        <Tooltip label="Settings" side="right">
          <button className="icon-btn" onClick={() => navigate("/settings")}>⚙</button>
        </Tooltip>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="logo"><span className="logo-mark">α</span> little alphaxiv</span>
        <Tooltip label="Collapse sidebar" side="bottom">
          <button className="icon-btn head-collapse" onClick={collapse}>«</button>
        </Tooltip>
      </div>
      <button className="new-chat-btn" onClick={newChat}>+ New chat</button>
      <button className="new-chat-btn secondary" onClick={() => openLocalPaper()}>+ Open Paper</button>

      <div className="conv-list">
        {items.length === 0 && <div className="conv-empty">No conversations yet.</div>}
        {grouped.map((g) => (
          <div className="conv-group" key={g.label}>
            <div className="conv-group-label">{g.label}</div>
            {g.items.map((it) => {
              if (it.kind === "general") {
                return (
                  <GeneralHistoryRow
                    key={it.history.id}
                    history={it.history}
                    activeId={activeId}
                    onSelect={(id) => {
                      setActive(id);
                      navigate(`/chat/${id}`);
                    }}
                    onRemove={remove}
                  />
                );
              }
              // paper group
              const active = it.threads.some((t) => t.id === activeId);
              const title = paperGroupLabel(it.paperId, paperTitles[it.paperId], it.rep);
              return (
                <div
                  key={`paper-${it.paperId}`}
                  className={`conv-item ${active ? "active" : ""}`}
                  onClick={() => {
                    setActive(it.rep.id);
                    navigate(`/paper/${encodeURIComponent(it.paperId)}/${it.rep.id}`);
                  }}
                >
                  <span className="conv-tag">📄</span>
                  <span className="conv-title">{title}</span>
                  {it.threads.length > 1 && <span className="conv-count">{it.threads.length}</span>}
                  <Tooltip label={`Delete all ${it.threads.length} conversation(s) for this paper`} side="top">
                    <button
                      className="conv-del"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!window.confirm(
                          `Delete all ${it.threads.length} conversation nodes for this paper? This cannot be undone.`,
                        )) return;
                        void removeMany(it.threads.map((t) => t.id));
                      }}
                    >×</button>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <div className="provider-status">
          {providers.length === 0 ? (
            <button
              className="warn provider-jump"
              onClick={() => navigate("/settings#providers")}
              title="Open Settings → Providers"
            >
              ⚠ No provider — configure in Settings
            </button>
          ) : (
            <span>{providers.length} provider(s) configured</span>
          )}
        </div>
        <div className="theme-quick">
          <label htmlFor="sb-theme">Theme</label>
          <select id="sb-theme" value={theme} onChange={(e) => setTheme(e.target.value)}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
        <button className="settings-btn" onClick={() => navigate("/settings")}>⚙ Settings</button>
        <button
          className="settings-btn"
          onClick={async () => {
            try { await import("../lib/api").then((m) => m.logout()); } catch { /* ignore */ }
            useSettings.getState().reset();
            window.location.assign("/login");
          }}
        >⎋ Log out</button>
      </div>
    </aside>
  );
}
