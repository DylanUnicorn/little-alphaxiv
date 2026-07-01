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
import type { ChatMessage, Paper, Attachment, StylePreset, ConversationType, Provider, ModelInfo, TokenUsage } from "../types";
import { STYLE_PRESETS } from "../types";
import { useConversations } from "../store/conversations";
import { useSettings } from "../store/settings";
import { runConversation, generateConversationTitle } from "../lib/llm";
import { truncateToFit, resolveForConv, estimateTokens, computeCalibration } from "../lib/contextBudget";
import { resolveVisionFallback } from "../lib/visionFallback";
import { isAbortError } from "../lib/chatStop";
import * as db from "../lib/db";
import { openTarget } from "../lib/paperSource";
import { PaperCard } from "./PaperCard";
import { Markdown } from "./Markdown";
import { ChatErrorBoundary } from "./ChatErrorBoundary";
import { ChatComposer } from "./ChatComposer";

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

/** After the first turn of a conversation, ask the configured model to summarize
 *  the exchange (grounded in the paper for paper chats) into a short title and
 *  rename the conversation. Fire-and-forget: never blocks the chat, never
 *  throws. The instant truncated-first-message title set in send() stays in
 *  place if this fails or is slow. */
async function maybeSummarizeTitle(args: {
  convId: string;
  type: ConversationType;
  paperId?: string;
  model?: string;
  provider: Provider;
  firstUserText: string;
  newMessages: ChatMessage[];
  rename: (id: string, title: string) => Promise<void>;
}): Promise<void> {
  try {
    // The final text answer is the last assistant message with real content;
    // earlier assistant messages in the tool loop carry tool_calls (content null).
    const lastAnswer = [...args.newMessages]
      .reverse()
      .find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim());
    const firstAssistant = (lastAnswer?.content as string | null) ?? "";

    let paperContext;
    if (args.type === "paper" && args.paperId) {
      const p = await db.getPaper(args.paperId);
      // Always ground the title in the arxiv id for paper chats — even before
      // metadata/full text has been cached — so the model knows it's a paper
      // thread and can reflect the paper's topic.
      paperContext = {
        arxivId: args.paperId,
        ...(p
          ? { title: p.title, abstract: p.abstract, fullTextSnippet: p.full_text }
          : {}),
      };
    }

    const title = await generateConversationTitle({
      provider: args.provider,
      model: args.model,
      firstUserMessage: args.firstUserText,
      firstAssistantMessage: firstAssistant,
      paperContext,
    });
    if (title) await args.rename(args.convId, title);
  } catch {
    // Title generation is best-effort; never surface to the user.
  }
}

export function ChatPanel({ conversationId, systemPrompt, showPaperLinks = true }: Props) {
  const navigate = useNavigate();
  const conv = useConversations((s) => s.conversations.find((c) => c.id === conversationId));
  const appendMessages = useConversations((s) => s.appendMessages);
  const rename = useConversations((s) => s.rename);
  // settings are updated via ChatToolbar callbacks or model selector
  const provider = useSettings((s) => s.getProvider(conv?.provider_id ?? null));
  // Select the stable searchSources object; derive enabled booleans locally
  // to avoid returning a fresh object from the selector (zustand footgun).
  const searchSources = useSettings((s) => s.searchSources);
  const enabledSources = { openalex: searchSources.openalex.enabled, s2: searchSources.semanticScholar.enabled };

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [streaming, setStreaming] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // AbortController for the current in-flight turn, if any. Null when idle.
  // Clicking Stop aborts the streaming fetch (runConversation already threads
  // the signal through to fetch); the catch block distinguishes that user abort
  // from a real network/upstream error.
  const abortRef = useRef<AbortController | null>(null);
  // Seed the paper's metadata into IDB (so PaperView/PdfViewer show real
  // title/authors/abstract instead of the bare-id fallback), then open it.
  // arXiv-id papers -> existing /api/pdf path; OA papers -> /api/pdf-url
  // proxy; otherwise -> external landing page in a new tab.
  const onOpenPaper = useCallback(async (paper: Paper) => {
    const target = openTarget(paper);
    if (target.kind === "external") {
      if (target.url) window.open(target.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (target.kind === "unfetchable") {
      // The unfetchable card's 3 action buttons drive the Open Local Paper
      // dialog; the card body has no click handler, but guard anyway so a
      // stray click never navigates to a paper that has no in-app PDF.
      return;
    }
    await db.savePaper({
      arxiv_id: target.id,
      title: paper.title,
      authors: paper.authors,
      abstract: paper.abstract,
      pdf_url: paper.pdf_url,
      abs_url: paper.abs_url,
      published: paper.published,
      primary_category: paper.primary_category,
      ...(paper.source ? { source: paper.source } : {}),
      ...(paper.doi ? { doi: paper.doi } : {}),
      ...(target.kind === "oa" ? { oa_pdf_url: target.url } : {}),
      fetched_at: Date.now(),
    });
    navigate(`/paper/${encodeURIComponent(target.id)}`);
  }, [navigate]);

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
      fetchAndCacheModels(provider.id);
    }
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stick-to-bottom: auto-follow new content only while the user is already
  // near the bottom. Checking the live scroll position at effect time (rather
  // than a flag toggled by onScroll) means a streamed token's render can never
  // race ahead of the scroll event and yank the user back down while they're
  // reading earlier messages. Instant scroll (not smooth): smooth-per-token
  // never settles and thrashes the main thread.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 120) return;
    el.scrollTop = el.scrollHeight;
  }, [conv?.messages.length, streaming, status]);

  // Switching conversations: jump to the bottom of the new thread.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  // Shared ingest: encode image File(s) to base64 data URLs and append to
  // attachments. Image-only (matches <input accept="image/*">); non-images
  // are silently skipped — callers that want a rejection signal (drag-drop)
  // call pickImageFiles first and pass only images here.
  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
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
  }, []);

  // Handle paste — extract images from clipboard (silent skip for non-images).
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    let hadImage = false;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        hadImage = true;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (hadImage) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  // Handle file input (click to upload).
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) addFiles(Array.from(files));
    e.target.value = ""; // reset so the same file can be re-selected
  }, [addFiles]);

  // Handle drag-and-drop image drop (wired to ChatComposer.onDropFiles).
  const handleDropFiles = useCallback((files: File[]) => {
    addFiles(files);
  }, [addFiles]);

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

  // Truncate history to fit the model's context window (capacity − reserve),
  // keeping the system prompt as a fixed, un-droppable cost. Replaces the old
  // message-count slice. Tool-group-aware: never orphans a tool result from the
  // tool_call that produced it. See lib/contextBudget.truncateToFit.
  // `modelId` is the EFFECTIVE model for this turn (may be the auto-swapped
  // vision model), so the ring + truncator use the right context window.
  function getContextMessages(modelId: string): ChatMessage[] {
    const modelInfo = cachedModels.find((m) => m.id === modelId);
    const { capacity, reserve } = resolveForConv({
      model: { id: modelId, context_length: modelInfo?.context_length },
      capacityOverride: c.context_capacity_override,
      reserveOverride: c.reserve_tokens,
    });
    const { messages } = truncateToFit(
      c.messages,
      capacity,
      reserve,
      effectiveSystemPrompt,
      c.last_usage?.calibration
    );
    return messages;
  }

  function stop() {
    abortRef.current?.abort();
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
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setStatus("Thinking…");

    // First turn: set an instant title from the question (so the sidebar
    // updates immediately), then refine it with an LLM summary once the
    // assistant replies (see maybeSummarizeTitle below).
    const wasFirstTurn = c.messages.length === 0;
    if (wasFirstTurn) {
      rename(c.id, text.slice(0, 48) || (attachments.length > 0 ? "Image chat" : "New chat"));
    }

    let buf = "";
    // Vision auto-fallback: if the about-to-be-sent context carries an image
    // and the current model isn't vision-capable, route to the provider's
    // configured vision_model (same base_url + api_key) and persist the swap
    // on the conversation so it sticks for follow-ups and the model dropdown
    // reflects reality. Images persist in history, so once true it stays true
    // until that message is truncated out — which is why the swap is sticky.
    // Declared OUTSIDE try: the catch block below also reads hasImage.
    const hasImage = [...c.messages, userMsg].some(
      (m) =>
        m.role === "user" &&
        !!m.attachments &&
        m.attachments.some((a) => a.type === "image")
    );
    try {
      const baseModel = c.model || provider.model || "";
      const { shouldSwap, model: effectiveModel } = resolveVisionFallback({
        hasImage,
        currentModel: baseModel,
        visionModel: provider.vision_model,
      });
      if (shouldSwap) {
        void _updateSettings(c.id, { model: effectiveModel });
        setStatus(`Switched to ${effectiveModel} for image input…`);
      }

      const contextMsgs = getContextMessages(effectiveModel);
      const history: ChatMessage[] = [...contextMsgs, userMsg];
      const { newMessages } = await runConversation({
        provider,
        messages: history,
        systemPrompt: effectiveSystemPrompt,
        model: effectiveModel,
        enabledSources,
        searchSourceCreds: {
          openalex: searchSources.openalex,
          semanticScholar: searchSources.semanticScholar,
        },
        signal: controller.signal,
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
          onUsage: (usage: TokenUsage, requestMessages: unknown[]) => {
            // Calibrate the heuristic estimate against the provider's real
            // prompt_tokens for this exact request, then persist so the
            // context ring tracks ground truth on subsequent turns.
            const est = estimateTokens(
              requestMessages as { role: string; content: unknown }[]
            );
            const calibration = computeCalibration(usage.prompt_tokens, est);
            void _updateSettings(c.id, {
              last_usage: {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
                calibration,
                ts: Date.now(),
              },
            });
          },
        },
      });
      setStatus("");
      // Refine the first-turn title into a short LLM summary. Fire-and-forget;
      // the truncated fallback stays if this is slow or fails.
      if (wasFirstTurn) {

        void maybeSummarizeTitle({
          convId: c.id,
          type: c.type,
          paperId: c.paper_id,
          model: effectiveModel,
          provider,
          firstUserText: text,
          newMessages,
          rename,
        });
      }
    } catch (e: any) {
      setStreaming("");
      setReasoning("");
      if (isAbortError(controller.signal, e)) {
        // User clicked Stop. Keep whatever already streamed this round and mark
        // it "已停止" (dim, not red). If nothing streamed yet (stopped during a
        // search/tool phase before any assistant text), append nothing — the
        // turn just ends cleanly and the next send works normally.
        if (buf.trim()) {
          await appendMessages(c.id, [
            { role: "assistant", content: buf, ui: { stopped: true } },
          ]);
        }
      } else {
        // Real error (network / upstream), including the image/vision case:
        // when an image was sent to a non-vision model and the user hasn't
        // configured a vision_model, the provider rejects it with an
        // image/vision/multimodal error. Surface an actionable hint instead of
        // the raw upstream body. (When a vision_model IS configured, the
        // proactive swap above should have prevented this error entirely.)
        const rawMsg = e?.message || "error";
        const looksLikeImageError = /image|vision|multimodal|does not support/i.test(rawMsg);
        const errMsg =
          hasImage && !provider.vision_model && looksLikeImageError
            ? "This model doesn't support images. Add a vision model in Settings → Providers."
            : rawMsg;
        // Preserve whatever had already streamed before the error so the user
        // doesn't lose the in-progress answer when a stream is interrupted (e.g.
        // the connection dropped while the tab was backgrounded). Previously the
        // partial buffer was discarded and replaced with a bare error message,
        // so the output the user was reading would vanish mid-reply.
        if (buf.trim()) {
          await appendMessages(c.id, [
            { role: "assistant", content: buf, ui: { error: `Response interrupted: ${errMsg}` } },
          ]);
        } else {
          await appendMessages(c.id, [
            { role: "assistant", content: `⚠️ ${errMsg}`, ui: { error: String(errMsg) } },
          ]);
        }
      }
      setStatus("");
    } finally {
      abortRef.current = null;
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
      <ChatComposer
        value={input}
        onValueChange={setInput}
        onSend={() => send()}
        onStop={() => stop()}
        onKeyDown={onKey}
        onPaste={handlePaste}
        onAttach={() => fileInputRef.current?.click()}
        onDropFiles={handleDropFiles}
        busy={busy}
        placeholder={busy ? "…" : "Message…  (Enter to send, Shift+Enter newline, Ctrl+V to paste images)"}
        attachments={attachments}
        onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
        models={availableModels}
        currentModel={currentModel}
        onModelChange={handleModelChange}
        conversationId={c.id}
        systemPrompt={effectiveSystemPrompt}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />
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
  onOpenPaper: (paper: Paper) => void;
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
          papers.map((p) => <PaperCard key={p.arxiv_id || p.doi || `p${papers.indexOf(p)}`} paper={p} onClick={() => onOpenPaper(p)} />)}
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
      {msg.ui?.stopped && <div className="msg-stopped">已停止</div>}
    </div>
  );
});
