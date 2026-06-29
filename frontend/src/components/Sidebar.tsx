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

import { useNavigate } from "react-router-dom";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { THEMES } from "../themes";
import { groupByDate } from "../lib/dates";
import type { Conversation } from "../types";
import { Tooltip } from "./Tooltip";

type Item =
  | { kind: "general"; conv: Conversation }
  | { kind: "paper"; paperId: string; threads: Conversation[]; rep: Conversation };

/** Timestamp used to bucket a sidebar item into a date group. */
function itemTs(it: Item): number {
  return it.kind === "general" ? it.conv.updated_at : it.rep.updated_at;
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

  // Build sidebar items: general convs + paper groups.
  const items: Item[] = [];
  const paperGroups = new Map<string, Conversation[]>();
  for (const c of conversations) {
    if (c.type === "general") {
      items.push({ kind: "general", conv: c });
    } else if (c.paper_id) {
      const arr = paperGroups.get(c.paper_id) ?? [];
      arr.push(c);
      paperGroups.set(c.paper_id, arr);
    }
  }
  for (const [paperId, threads] of paperGroups) {
    const rep = threads.slice().sort((a, b) => b.updated_at - a.updated_at)[0];
    items.push({ kind: "paper", paperId, threads, rep });
  }
  // Most-recently-touched first.
  items.sort((a, b) => {
    const ta = a.kind === "general" ? a.conv.updated_at : a.rep.updated_at;
    const tb = b.kind === "general" ? b.conv.updated_at : b.rep.updated_at;
    return tb - ta;
  });
  // Bucket into alphaxiv-style date groups (items are already MRU, so each
  // group's internal order is preserved).
  const grouped = groupByDate(items, itemTs);

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-collapsed">
        <Tooltip label="Expand sidebar" side="right">
          <button className="icon-btn" onClick={expand}>»</button>
        </Tooltip>
        <Tooltip label="New chat" side="right">
          <button className="icon-btn" onClick={newChat}>+</button>
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

      <div className="conv-list">
        {items.length === 0 && <div className="conv-empty">No conversations yet.</div>}
        {grouped.map((g) => (
          <div className="conv-group" key={g.label}>
            <div className="conv-group-label">{g.label}</div>
            {g.items.map((it) => {
              if (it.kind === "general") {
                const active = it.conv.id === activeId;
                return (
                  <div
                    key={it.conv.id}
                    className={`conv-item ${active ? "active" : ""}`}
                    onClick={() => {
                      setActive(it.conv.id);
                      navigate(`/chat/${it.conv.id}`);
                    }}
                  >
                    <span className="conv-tag">💬</span>
                    <span className="conv-title">{it.conv.title || "New chat"}</span>
                    <Tooltip label="Delete" side="top">
                      <button
                        className="conv-del"
                        onClick={(e) => { e.stopPropagation(); remove(it.conv.id); }}
                      >×</button>
                    </Tooltip>
                  </div>
                );
              }
              // paper group
              const active = it.threads.some((t) => t.id === activeId);
              const title = it.rep.title && it.rep.title !== "Paper discussion" ? it.rep.title : `📄 ${it.paperId}`;
              return (
                <div
                  key={`paper-${it.paperId}`}
                  className={`conv-item ${active ? "active" : ""}`}
                  onClick={() => {
                    setActive(it.rep.id);
                    navigate(`/paper/${it.paperId}/${it.rep.id}`);
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
                        removeMany(it.threads.map((t) => t.id));
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
