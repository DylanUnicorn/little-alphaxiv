// Chat toolbar — top bar of the chat panel in paper view.
// Left: history toggle (opens the HistoryPanel) + current thread title.
// Right: new-conversation button + settings dropdown (style /
// theme). The history is a full panel (see HistoryPanel), not a
// dropdown — the dropdown was too crude to tell threads apart.

import { useState, useRef, useEffect } from "react";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { THEMES } from "../themes";
import { STYLE_PRESETS, type StylePreset } from "../types";
import { groupConversationHistories } from "../lib/conversationBranches";
import { HistoryQuickTreePopover } from "./HistoryQuickTreePopover";
import { Tooltip } from "./Tooltip";

interface Props {
  conversationId: string;
  arxivId: string;
  showHistory: boolean;
  onToggleHistory: () => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onStyleChange: (style: StylePreset) => void;
}

export function ChatToolbar({
  conversationId,
  arxivId,
  showHistory,
  onToggleHistory,
  onSelectConversation,
  onNewConversation,
  onStyleChange,
}: Props) {
  const conversations = useConversations((s) => s.conversations);
  const activeConv = conversations.find((c) => c.id === conversationId);
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);

  const [showSettings, setShowSettings] = useState(false);
  const [showQuickHistory, setShowQuickHistory] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const quickCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Paper conversations for this arxiv_id (count badge on the history toggle).
  const paperConvs = conversations.filter(
    (c) => c.type === "paper" && c.paper_id === arxivId
  );
  const activeHistory = groupConversationHistories(paperConvs).find(
    (history) => history.nodes.some((node) => node.id === conversationId),
  );

  function clearQuickCloseTimer() {
    if (quickCloseTimer.current) clearTimeout(quickCloseTimer.current);
    quickCloseTimer.current = null;
  }

  function openQuickHistory() {
    clearQuickCloseTimer();
    if (!showHistory && activeHistory) setShowQuickHistory(true);
  }

  function closeQuickHistory() {
    clearQuickCloseTimer();
    setShowQuickHistory(false);
  }

  function scheduleQuickHistoryClose() {
    clearQuickCloseTimer();
    quickCloseTimer.current = setTimeout(() => {
      setShowQuickHistory(false);
      quickCloseTimer.current = null;
    }, 160);
  }

  // Close settings dropdown on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node))
        setShowSettings(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (showHistory) closeQuickHistory();
  }, [showHistory]);

  useEffect(() => setShowQuickHistory(false), [arxivId, conversationId]);

  useEffect(() => () => clearQuickCloseTimer(), []);

  const currentStyle: StylePreset = activeConv?.style_preset || "default";

  const threadTitle =
    activeConv?.title && activeConv.title !== "Paper discussion" && !activeConv.title.startsWith("📄")
      ? activeConv.title
      : "New discussion";

  return (
    <div className="chat-toolbar">
      <div className="chat-toolbar-left">
        <span className="toolbar-conv-title">{threadTitle}</span>
      </div>

      <div className="chat-toolbar-right">
        <Tooltip label="New conversation" side="bottom">
          <button className="toolbar-action-btn" onClick={onNewConversation}>
            <span className="toolbar-action-icon" aria-hidden>⊕</span>
            <span>New Chat</span>
          </button>
        </Tooltip>

        <div
          className="history-quick-trigger"
          onMouseEnter={openQuickHistory}
          onMouseLeave={scheduleQuickHistoryClose}
        >
          <button
            ref={historyButtonRef}
            className={`toolbar-action-btn ${showHistory ? "active" : ""}`}
            onClick={() => {
              closeQuickHistory();
              onToggleHistory();
            }}
            aria-label="Conversation history"
            aria-expanded={showHistory}
          >
            <span className="toolbar-action-icon" aria-hidden>↶</span>
            <span>History</span>
            <span className="conv-count">{paperConvs.length}</span>
          </button>
        </div>

        <HistoryQuickTreePopover
          open={showQuickHistory && !showHistory}
          anchorRef={historyButtonRef}
          nodes={activeHistory?.nodes ?? []}
          activeId={conversationId}
          onSelect={(id) => {
            closeQuickHistory();
            onSelectConversation(id);
          }}
          onClose={closeQuickHistory}
          onPointerEnter={openQuickHistory}
          onPointerLeave={scheduleQuickHistoryClose}
        />

        <div className="toolbar-dropdown" ref={settingsRef}>
          <Tooltip label="Chat settings" side="bottom">
            <button
              className={`toolbar-icon-btn ${showSettings ? "active" : ""}`}
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Chat settings"
            >⋮</button>
          </Tooltip>
          {showSettings && (
            <div className="dropdown-menu settings-menu">
              {/* Style preset */}
              <div className="settings-section">
                <label className="settings-label">Style</label>
                <div className="style-presets">
                  {(Object.keys(STYLE_PRESETS) as StylePreset[]).map((key) => (
                    <Tooltip key={key} label={STYLE_PRESETS[key].description} side="bottom">
                      <button
                        className={`style-preset-btn ${currentStyle === key ? "active" : ""}`}
                        onClick={() => onStyleChange(key)}
                      >
                        <span className="style-icon">{STYLE_PRESETS[key].icon}</span>
                        <span className="style-label-text">{STYLE_PRESETS[key].label}</span>
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>

              {/* Theme */}
              <div className="settings-section">
                <label className="settings-label">Theme</label>
                <select
                  className="settings-select"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                >
                  {THEMES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
