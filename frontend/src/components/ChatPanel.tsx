// Reusable chat panel. Renders messages, handles input, runs the LLM
// tool-calling loop, and renders surfaced papers as clickable cards.
// Used by both the general chat view and the per-paper chat view.
//
// Supports:
//   - Image paste (Ctrl+V) → attachments sent as multimodal content
//   - Per-conversation model override, style preset, context window
//   - GLM reasoning_content display as "thinking" block

import { memo, useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ChatMessage, Paper, Attachment, StylePreset, ModelInfo } from "../types";
import { STYLE_PRESETS } from "../types";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { runConversation } from "../lib/llm";
import { PaperCard } from "./PaperCard";
import { Markdown } from "./Markdown";
import { ChatErrorBoundary } from "./ChatErrorBoundary";

const GENERAL_SUGGESTIONS = [
  "Find recent papers on retrieval-augmented generation",
  "What's new in efficient LLM inference?",
  "Summarize trending research on multimodal learning",
];
const PAPER_SUGGESTIONS = [
  "Summarize this paper",
  "What are the key contributions?",
  "Explain the methodology",
  "What are the limitations?",
];

interface Props {
  conversationId: string;
  systemPrompt?: string;
  showPaperLinks?: boolean;
}

export function ChatPanel({ conversationId, systemPrompt, showPaperLinks = true }: Props) {
  const navigate = useNavigate();
  const conv = useConversations((s) => s.conversations.find((c) => c.id === conversationId));
  const appendMessages = useConversations((s) => s.appendMessages);
  const rename = useConversations((s) => s.rename);
  // settings are updated via ChatToolbar callbacks or model selector
  const provider = useSettings((s) => s.getProvider(conv?.provider_id ?? null));

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [streaming, setStreaming] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Stable callback so memoized MessageRows don't re-render on every keystroke.
  const onOpenPaper = useCallback((id: string) => navigate(`/paper/${id}`), [navigate]);

  // Model selector: use cached models from settings, or fall back to text input
  const cachedModels = useSettings((s) =>
    provider ? s.getCachedModels(provider.id) : []
  );
  const fetchAndCacheModels = useSettings((s) => s.fetchAndCacheModels);
  const [modelsFetched, setModelsFetched] = useState(false);
  const _updateSettings = useConversations((s) => s.updateSettings);

  // Lazily fetch models when panel mounts (if not yet cached)
  useEffect(() => {
    if (provider && cachedModels.length === 0 && !modelsFetched) {
      setModelsFetched(true);
      fetchAndCacheModels(provider.id, provider.base_url, provider.api_key);
    }
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [conv?.messages.length, streaming, status]);

  // Handle paste — extract images from clipboard
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setAttachments((prev) => [
            ...prev,
            { type: "image", data_url: dataUrl, name: file.name },
          ]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  // Handle file input (click to upload)
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          setAttachments((prev) => [
            ...prev,
            { type: "image", data_url: dataUrl, name: file.name },
          ]);
        };
        reader.readAsDataURL(file);
      }
    }
    e.target.value = ""; // reset
  }, []);

  if (!conv) return <div className="chat-panel"><p>No conversation.</p></div>;

  const c = conv;

  // Model selector derived values (need `c` which is assigned above)
  const currentModel = c.model || provider?.model || "";
  const availableModels: ModelInfo[] = cachedModels;

  function handleModelChange(newModel: string) {
    if (!c.id) return;
    _updateSettings(c.id, { model: newModel });
  }

  // Build the effective system prompt with style preset modifier
  const stylePreset: StylePreset = c.style_preset || "default";
  const effectiveSystemPrompt =
    (systemPrompt || "") + (STYLE_PRESETS[stylePreset]?.promptMod || "");

  // Apply context window limit to history
  function getContextMessages(): ChatMessage[] {
    const ctxWindow = c.context_window || 0;
    if (ctxWindow > 0 && c.messages.length > ctxWindow) {
      return c.messages.slice(-ctxWindow);
    }
    return c.messages;
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if ((!text && attachments.length === 0) || busy) return;
    if (!provider) {
      setStatus("No provider configured. Add one in Settings.");
      return;
    }

    const userMsg: ChatMessage = {
      role: "user",
      content: text || null,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    };
    await appendMessages(c.id, [userMsg]);
    setInput("");
    setAttachments([]);
    setBusy(true);
    setStatus("Thinking…");

    if (c.messages.length === 0) {
      rename(c.id, text.slice(0, 48) || (attachments.length > 0 ? "Image chat" : "New chat"));
    }

    try {
      const contextMsgs = getContextMessages();
      const history: ChatMessage[] = [...contextMsgs, userMsg];
      let buf = "";
      await runConversation({
        provider,
        messages: history,
        systemPrompt: effectiveSystemPrompt,
        model: c.model,
        callbacks: {
          onAssistantStart: () => {
            buf = "";
            setStreaming("");
            setReasoning("");
          },
          onAssistantDelta: (t) => {
            buf += t;
            setStreaming(buf);
          },
          onReasoning: (t) => {
            setReasoning((r) => (r + t).slice(-2000));
            if (buf === "") setStatus("Thinking…");
          },
          onAssistantMessage: (msg) => {
            setStreaming("");
            setReasoning("");
            appendMessages(c.id, [msg]);
          },
          onToolMessage: (msg) => appendMessages(c.id, [msg]),
          onPapers: () => setStatus("Found papers…"),
          onStatus: (s) => setStatus(s),
        },
      });
      setStatus("");
    } catch (e: any) {
      setStreaming("");
      setReasoning("");
      await appendMessages(c.id, [
        { role: "assistant", content: `⚠️ ${e?.message || "error"}`, ui: { error: String(e?.message || e) } },
      ]);
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="chat-panel">
      <ChatErrorBoundary>
        <div className="chat-messages" ref={scrollRef}>
          {conv.messages.length === 0 && !streaming && (
            <div className="chat-empty">
              <div className="empty-title">{conv.type === "paper" ? "Discuss this paper" : "Find papers with AI"}</div>
              <div className="empty-sub">
                {conv.type === "paper"
                  ? "Ask about methods, results, or limitations — the full text is in context."
                  : "Describe a topic and I'll search arXiv, returning clickable links to preview papers."}
              </div>
              <div className="chat-suggestions">
                {(conv.type === "paper" ? PAPER_SUGGESTIONS : GENERAL_SUGGESTIONS).map((s) => (
                  <button key={s} className="suggestion-chip" onClick={() => send(s)} disabled={busy}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {conv.messages.map((m, i) => (
            <MessageRow key={i} msg={m} showPaperLinks={showPaperLinks} onOpenPaper={onOpenPaper} />
          ))}
          {streaming && (
            <div className="msg msg-assistant pending">
              <Markdown>{streaming}</Markdown>
            </div>
          )}
          {reasoning && !streaming && (
            <div className="msg msg-reasoning">
              <span className="reasoning-label" onClick={() => setReasoningOpen((o) => !o)}>
                <span>{reasoningOpen ? "▾" : "▸"}</span> thinking
              </span>
              {reasoningOpen && (
                <Markdown>{reasoning}</Markdown>
              )}
            </div>
          )}
        </div>
      </ChatErrorBoundary>
      <div className="chat-status">
        {streaming ? (<><span className="streaming-cursor" /> Generating…</>) : status}
      </div>
      {/* Model selector */}
      {provider && (
        <div className="chat-model-selector">
          <span className="chat-model-label">Model:</span>
          {availableModels.length > 0 ? (
            <select
              className="chat-model-select"
              value={currentModel}
              onChange={(e) => handleModelChange(e.target.value)}
              title="Select model for this conversation"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>{m.id}</option>
              ))}
            </select>
          ) : (
            <input
              className="chat-model-input"
              value={currentModel}
              onChange={(e) => handleModelChange(e.target.value)}
              placeholder="Enter model id…"
              title="Model for this conversation"
            />
          )}
          {availableModels.length === 0 && !modelsFetched && (
            <button
              className="chat-model-fetch-btn"
              onClick={() => {
                setModelsFetched(true);
                fetchAndCacheModels(provider.id, provider.base_url, provider.api_key);
              }}
              title="Fetch available models from provider"
            >
              Fetch
            </button>
          )}
        </div>
      )}
      <div className="chat-input-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={handleFileSelect}
        />
        <button
          className="attach-btn"
          title="Attach image"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          📎
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          onPaste={handlePaste}
          placeholder={busy ? "…" : "Message…  (Enter to send, Shift+Enter newline, Ctrl+V to paste images)"}
          rows={1}
          disabled={busy}
        />
        <button onClick={() => send()} disabled={busy || (!input.trim() && attachments.length === 0)}>
          {busy ? "…" : "Send"}
        </button>
      </div>
      {/* Attachment previews — rendered below input row */}
      {attachments.length > 0 && (
        <div className="attachment-previews">
          {attachments.map((att, i) => (
            <div key={i} className="attachment-preview">
              <img src={att.data_url} alt={att.name || "attachment"} />
              <button
                className="attachment-remove"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  msg,
  showPaperLinks,
  onOpenPaper,
}: {
  msg: ChatMessage;
  showPaperLinks: boolean;
  onOpenPaper: (id: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="msg msg-user">
        {msg.content}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="msg-attachments">
            {msg.attachments.map((att, i) => (
              <img key={i} src={att.data_url} alt={att.name || "attachment"} className="msg-attachment-img" />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (msg.role === "tool") {
    const papers: Paper[] = msg.ui?.papers ?? [];
    if (!papers.length) return null;
    return (
      <div className="msg msg-tool">
        {showPaperLinks &&
          papers.map((p) => <PaperCard key={p.arxiv_id} paper={p} onClick={() => onOpenPaper(p.arxiv_id)} />)}
      </div>
    );
  }
  // assistant
  return (
    <div className="msg msg-assistant">
      {msg.content ? (
        <Markdown>{msg.content}</Markdown>
      ) : (
        ""
      )}
      {msg.ui?.error && <div className="msg-error">{msg.ui.error}</div>}
    </div>
  );
});
