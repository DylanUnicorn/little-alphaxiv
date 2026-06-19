// Chat toolbar — top bar of the chat panel in paper view.
// Left: history toggle (opens the HistoryPanel) + current thread title.
// Right: new-conversation button + settings dropdown (model / style /
// theme). The history is a full panel (see HistoryPanel), not a
// dropdown — the dropdown was too crude to tell threads apart.

import { useState, useRef, useEffect } from "react";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { fetchModels } from "../lib/api";
import { THEMES } from "../themes";
import { STYLE_PRESETS, type StylePreset, type ModelInfo } from "../types";

interface Props {
  conversationId: string;
  arxivId: string;
  showHistory: boolean;
  onToggleHistory: () => void;
  onNewConversation: () => void;
  onModelChange: (model: string) => void;
  onStyleChange: (style: StylePreset) => void;
}

export function ChatToolbar({
  conversationId,
  arxivId,
  showHistory,
  onToggleHistory,
  onNewConversation,
  onModelChange,
  onStyleChange,
}: Props) {
  const conversations = useConversations((s) => s.conversations);
  const activeConv = conversations.find((c) => c.id === conversationId);
  const provider = useSettings((s) => s.getProvider(activeConv?.provider_id ?? null));
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);

  const [showSettings, setShowSettings] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Paper conversations for this arxiv_id (count badge on the history toggle).
  const paperConvs = conversations.filter(
    (c) => c.type === "paper" && c.paper_id === arxivId
  );

  // Fetch models when settings dropdown opens.
  useEffect(() => {
    if (showSettings && provider && models.length === 0 && !loadingModels) {
      setLoadingModels(true);
      fetchModels(provider.base_url, provider.api_key)
        .then((m) => setModels(m))
        .catch(() => setModels([]))
        .finally(() => setLoadingModels(false));
    }
  }, [showSettings, provider, models.length, loadingModels]);

  // Close settings dropdown on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node))
        setShowSettings(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const currentStyle: StylePreset = activeConv?.style_preset || "default";
  const currentModel = activeConv?.model || provider?.model || "";

  const threadTitle =
    activeConv?.title && activeConv.title !== "Paper discussion" && !activeConv.title.startsWith("📄")
      ? activeConv.title
      : "New discussion";

  return (
    <div className="chat-toolbar">
      <div className="chat-toolbar-left">
        <button
          className={`toolbar-btn ${showHistory ? "active" : ""}`}
          title="Conversation history"
          onClick={onToggleHistory}
        >
          ☰ <span className="conv-count">{paperConvs.length}</span>
        </button>
        <span className="toolbar-conv-title">{threadTitle}</span>
      </div>

      <div className="chat-toolbar-right">
        <button className="toolbar-btn" title="New conversation" onClick={onNewConversation}>✚</button>

        <div className="toolbar-dropdown" ref={settingsRef}>
          <button
            className={`toolbar-btn ${showSettings ? "active" : ""}`}
            title="Chat settings"
            onClick={() => setShowSettings((v) => !v)}
          >⚙</button>
          {showSettings && (
            <div className="dropdown-menu settings-menu">
              {/* Model selector */}
              <div className="settings-section">
                <label className="settings-label">Model</label>
                {loadingModels ? (
                  <div className="settings-loading">Loading models…</div>
                ) : models.length > 0 ? (
                  <select
                    className="settings-select"
                    value={currentModel}
                    onChange={(e) => onModelChange(e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{m.id}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="settings-input"
                    value={currentModel}
                    onChange={(e) => onModelChange(e.target.value)}
                    placeholder="model id"
                  />
                )}
              </div>

              {/* Style preset */}
              <div className="settings-section">
                <label className="settings-label">Style</label>
                <div className="style-presets">
                  {(Object.keys(STYLE_PRESETS) as StylePreset[]).map((key) => (
                    <button
                      key={key}
                      className={`style-preset-btn ${currentStyle === key ? "active" : ""}`}
                      onClick={() => onStyleChange(key)}
                      title={STYLE_PRESETS[key].description}
                    >
                      <span className="style-icon">{STYLE_PRESETS[key].icon}</span>
                      <span className="style-label-text">{STYLE_PRESETS[key].label}</span>
                    </button>
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
