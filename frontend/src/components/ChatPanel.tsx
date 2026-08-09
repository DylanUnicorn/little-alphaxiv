// Reusable chat panel. Renders messages, handles input, runs the LLM
// tool-calling loop, and renders surfaced papers as clickable cards.
// Used by both the general chat view and the per-paper chat view.
//
// Supports:
//   - Image paste (Ctrl+V) → attachments sent as multimodal content
//   - Per-conversation model override, style preset, context window
//   - GLM reasoning_content display as "thinking" block

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";
import type { ChatMessage, Paper, Attachment, StylePreset, ConversationType, Provider, ModelInfo, TokenUsage } from "../types";
import { STYLE_PRESETS } from "../types";
import { useConversations } from "../store/conversations";
import { EMPTY_CHAT_TURN, useChatRuntime } from "../store/chatRuntime";
import { useSettings } from "../store/settings";
import { runConversation, generateConversationTitle } from "../lib/llm";
import { buildStreamFailureMessage, userFacingStreamError } from "../lib/chatFailure";
import { truncateToFit, resolveForConv, estimateTokens, computeCalibration } from "../lib/contextBudget";
import { resolveVisionFallback } from "../lib/visionFallback";
import { isAbortError } from "../lib/chatStop";
import {
  buildAssistantExcerptMessage,
  buildSelectedTextMessage,
  type SelectedPdfTextPayload,
} from "../lib/selectedTextAskAi";
import { buildChatRenderItems } from "../lib/agentActivity";
import { isPendingBranchConversation } from "../lib/conversationBranches";
import { writeRenderedMathSelection } from "../lib/renderedMathClipboard";
import * as db from "../lib/db";
import { openTarget } from "../lib/paperSource";
import { PaperCard } from "./PaperCard";
import { Markdown } from "./Markdown";
import { ChatErrorBoundary } from "./ChatErrorBoundary";
import { ChatComposer } from "./ChatComposer";
import { AgentActivity } from "./AgentActivity";
import { AssistantBranchAction } from "./AssistantBranchAction";
import { UserMessageActions } from "./UserMessageActions";

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
const EDITING_MESSAGE_CONTEXT = {
  label: "Editing message",
  text: "Sending replaces this message and removes the replies after it.",
};

function handleRenderedMathCopy(event: ReactClipboardEvent<HTMLDivElement>) {
  if (!writeRenderedMathSelection(window.getSelection(), event.clipboardData)) return;
  event.preventDefault();
}

interface Props {
  conversationId: string;
  systemPrompt?: string;
  showPaperLinks?: boolean;
  selectedTextContext?: SelectedPdfTextPayload | null;
  onRemoveSelectedText?: () => void;
  onSelectedTextSent?: (context: SelectedPdfTextPayload) => void;
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

export function ChatPanel({
  conversationId,
  systemPrompt,
  showPaperLinks = true,
  selectedTextContext,
  onRemoveSelectedText,
  onSelectedTextSent,
}: Props) {
  const navigate = useNavigate();
  const conv = useConversations((s) => s.conversations.find((c) => c.id === conversationId));
  const appendMessages = useConversations((s) => s.appendMessages);
  const replaceFromUserMessage = useConversations((s) => s.replaceFromUserMessage);
  const branchFromMessage = useConversations((s) => s.branchFromMessage);
  const rename = useConversations((s) => s.rename);
  // settings are updated via ChatToolbar callbacks or model selector
  const provider = useSettings((s) => s.getProvider(conv?.provider_id ?? null));
  // Select the stable searchSources object; derive enabled booleans locally
  // to avoid returning a fresh object from the selector (zustand footgun).
  const searchSources = useSettings((s) => s.searchSources);
  const enabledSources = { openalex: searchSources.openalex.enabled, s2: searchSources.semanticScholar.enabled, anysearch: searchSources.anysearch.enabled };
  const aiOutputFormat = useSettings((s) => s.aiOutputFormat);
  const turn = useChatRuntime((s) => s.turns[conversationId] ?? EMPTY_CHAT_TURN);
  const startTurn = useChatRuntime((s) => s.startTurn);
  const updateTurn = useChatRuntime((s) => s.updateTurn);
  const appendReasoning = useChatRuntime((s) => s.appendReasoning);
  const setNotice = useChatRuntime((s) => s.setNotice);
  const stopTurn = useChatRuntime((s) => s.stopTurn);
  const finishTurn = useChatRuntime((s) => s.finishTurn);
  const acknowledgeCompletion = useChatRuntime((s) => s.acknowledgeCompletion);
  const { busy, status, streaming, reasoning } = turn;

  const [input, setInput] = useState("");
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const renderItems = useMemo(
    () => buildChatRenderItems(conv?.messages ?? []),
    [conv?.messages]
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeConversationIdRef = useRef<string | null>(conversationId);
  activeConversationIdRef.current = conversationId;

  useEffect(() => {
    acknowledgeCompletion(conversationId);
    return () => {
      if (activeConversationIdRef.current === conversationId) {
        activeConversationIdRef.current = null;
      }
    };
  }, [acknowledgeCompletion, conversationId]);
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

  // Draft inputs belong to the visible branch. In-flight output does not: it
  // remains in chatRuntime under the conversation that launched the turn.
  useEffect(() => {
    setInput("");
    setAttachments([]);
    setEditingMessageIndex(null);
    setReasoningOpen(true);
  }, [conversationId]);

  const beginEditMessage = useCallback((messageIndex: number, message: ChatMessage) => {
    if (message.role !== "user") return;
    onRemoveSelectedText?.();
    setEditingMessageIndex(messageIndex);
    setInput(message.content ?? "");
    setAttachments(message.attachments ? [...message.attachments] : []);
    setFocusRequest((request) => request + 1);
  }, [onRemoveSelectedText]);

  const cancelMessageEdit = useCallback(() => {
    setEditingMessageIndex(null);
    setInput("");
    setAttachments([]);
  }, []);

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
  const handlePaste = useCallback((e: ClipboardEvent) => {
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

  // Keep this callback stable while the user edits the composer draft. It
  // also has to stay above the missing-conversation return: an ephemeral empty
  // thread is absent after refresh and can recover on the following render.
  const createBranch = useCallback(async (messageIndex: number, excerpt: string) => {
    if (!conv || busy || conv.type !== "paper") return;
    setNotice(conv.id, "Creating branch…");
    try {
      const child = await branchFromMessage({
        conversationId: conv.id,
        messageIndex,
        excerpt,
      });
      setNotice(conv.id, "");
      if (child.type === "paper" && child.paper_id) {
        navigate(`/paper/${encodeURIComponent(child.paper_id)}/${child.id}`);
      } else {
        navigate(`/chat/${child.id}`);
      }
    } catch (error: any) {
      setNotice(conv.id, `Could not create branch: ${error?.message || "error"}`);
      throw error;
    }
  }, [branchFromMessage, busy, conv?.id, conv?.type, navigate, setNotice]);

  if (!conv) return <div className="chat-panel"><p>No conversation.</p></div>;

  const c = conv;
  const pendingBranchExcerpt = isPendingBranchConversation(c)
    ? c.branch_excerpt ?? null
    : null;
  const composerSelectedTextContext = editingMessageIndex !== null
    ? EDITING_MESSAGE_CONTEXT
    : selectedTextContext
      ? { text: selectedTextContext.text, label: `Page ${selectedTextContext.pageNumber}` }
      : pendingBranchExcerpt
        ? { text: pendingBranchExcerpt, label: "Selected reply" }
        : null;
  const composerOnRemoveSelectedText = editingMessageIndex !== null
    ? cancelMessageEdit
    : selectedTextContext
      ? onRemoveSelectedText
      : undefined;
  const outputFormatStyle = {
    "--ai-output-font-size": `${aiOutputFormat.fontSize}px`,
    "--ai-output-line-height": String(aiOutputFormat.lineHeight),
    "--ai-output-paragraph-spacing": `${aiOutputFormat.paragraphSpacing}px`,
    "--ai-output-math-size": `${aiOutputFormat.mathScale}em`,
  } as CSSProperties;

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
  function getContextMessages(modelId: string, sourceMessages = c.messages): ChatMessage[] {
    const modelInfo = cachedModels.find((m) => m.id === modelId);
    const { capacity, reserve } = resolveForConv({
      model: { id: modelId, context_length: modelInfo?.context_length },
      capacityOverride: c.context_capacity_override,
      reserveOverride: c.reserve_tokens,
    });
    const { messages } = truncateToFit(
      sourceMessages,
      capacity,
      reserve,
      effectiveSystemPrompt,
      c.last_usage?.calibration
    );
    return messages;
  }

  function stop() {
    stopTurn(c.id);
  }

  async function send(override?: string) {
    const draft = (override ?? input).trim();
    const text = editingMessageIndex !== null
      ? draft
      : selectedTextContext
        ? buildSelectedTextMessage(selectedTextContext, draft)
        : pendingBranchExcerpt
          ? buildAssistantExcerptMessage(pendingBranchExcerpt, draft)
          : draft;
    const sentAttachments = attachments;
    const contextSuppliesContent = editingMessageIndex === null && !!composerSelectedTextContext;
    if ((!draft && sentAttachments.length === 0 && !contextSuppliesContent) || busy) return;
    if (!provider) {
      setNotice(c.id, "No provider configured. Add one in Settings.");
      return;
    }

    const userMsg: ChatMessage = {
      role: "user",
      content: text || null,
      ...(sentAttachments.length > 0 ? { attachments: [...sentAttachments] } : {}),
    };
    const controller = new AbortController();
    const launchConversationId = c.id;
    const editedMessageIndex = editingMessageIndex;
    const sourceMessages = editedMessageIndex === null
      ? c.messages
      : c.messages.slice(0, editedMessageIndex);
    // This synchronous store action closes the pre-render double-send gap for
    // one conversation, while another branch remains free to start its turn.
    if (!startTurn(launchConversationId, controller)) return;
    try {
      if (editedMessageIndex === null) {
        await appendMessages(launchConversationId, [userMsg]);
      } else {
        await replaceFromUserMessage(launchConversationId, editedMessageIndex, userMsg);
      }
    } catch (e: any) {
      finishTurn(launchConversationId, controller);
      setNotice(launchConversationId, `Failed to save message: ${e?.message || "error"}`);
      return;
    }
    setInput("");
    setAttachments([]);
    setEditingMessageIndex(null);
    if (editedMessageIndex === null && selectedTextContext) onSelectedTextSent?.(selectedTextContext);

    // First turn: set an instant title from the question (so the sidebar
    // updates immediately), then refine it with an LLM summary once the
    // assistant replies (see maybeSummarizeTitle below).
    const wasFirstTurn = editedMessageIndex === 0
      || (editedMessageIndex === null && (c.messages.length === 0 || !!pendingBranchExcerpt));
    if (wasFirstTurn) {
      const fallbackTitle = selectedTextContext
        ? draft || `Page ${selectedTextContext.pageNumber} excerpt`
        : pendingBranchExcerpt
          ? draft || pendingBranchExcerpt
          : draft;
      rename(launchConversationId, fallbackTitle.slice(0, 48) || (sentAttachments.length > 0 ? "Image chat" : "New chat"));
    }

    let buf = "";
    // Vision auto-fallback: if the about-to-be-sent context carries an image
    // and the current model isn't vision-capable, route to the provider's
    // configured vision_model (same base_url + api_key) and persist the swap
    // on the conversation so it sticks for follow-ups and the model dropdown
    // reflects reality. Images persist in history, so once true it stays true
    // until that message is truncated out — which is why the swap is sticky.
    // Declared OUTSIDE try: the catch block below also reads hasImage.
    const hasImage = [...sourceMessages, userMsg].some(
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
        void _updateSettings(launchConversationId, { model: effectiveModel });
        updateTurn(launchConversationId, controller, {
          status: `Switched to ${effectiveModel} for image input…`,
        });
      }

      const contextMsgs = getContextMessages(effectiveModel, sourceMessages);
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
          anysearch: searchSources.anysearch,
        },
        signal: controller.signal,
        callbacks: {
          onAssistantStart: () => {
            buf = "";
            updateTurn(launchConversationId, controller, {
              streaming: "",
              reasoning: "",
            });
          },
          onAssistantDelta: (t) => {
            buf += t;
            updateTurn(launchConversationId, controller, { streaming: buf });
          },
          onReasoning: (t) => {
            appendReasoning(launchConversationId, controller, t);
            if (buf === "") {
              updateTurn(launchConversationId, controller, { status: "Thinking…" });
            }
          },
          onAssistantMessage: (msg) => {
            updateTurn(launchConversationId, controller, {
              streaming: "",
              reasoning: "",
            });
            appendMessages(launchConversationId, [msg]);
          },
          onToolMessage: (msg) => appendMessages(launchConversationId, [msg]),
          onPapers: () => updateTurn(launchConversationId, controller, { status: "Found papers…" }),
          onStatus: (s) => updateTurn(launchConversationId, controller, { status: s }),
          onUsage: (usage: TokenUsage, requestMessages: unknown[]) => {
            // Calibrate the heuristic estimate against the provider's real
            // prompt_tokens for this exact request, then persist so the
            // context ring tracks ground truth on subsequent turns.
            const est = estimateTokens(
              requestMessages as { role: string; content: unknown }[]
            );
            const calibration = computeCalibration(usage.prompt_tokens, est);
            void _updateSettings(launchConversationId, {
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
      updateTurn(launchConversationId, controller, { status: "" });
      // Refine the first-turn title into a short LLM summary. Fire-and-forget;
      // the truncated fallback stays if this is slow or fails.
      if (wasFirstTurn) {

        void maybeSummarizeTitle({
          convId: launchConversationId,
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
      updateTurn(launchConversationId, controller, {
        streaming: "",
        reasoning: "",
      });
      if (isAbortError(controller.signal, e)) {
        // User clicked Stop. Keep whatever already streamed this round and mark
        // it "已停止" (dim, not red). If nothing streamed yet (stopped during a
        // search/tool phase before any assistant text), append nothing — the
        // turn just ends cleanly and the next send works normally.
        if (buf.trim()) {
          await appendMessages(launchConversationId, [
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
            : userFacingStreamError(rawMsg, Boolean(buf.trim()));
        // Preserve whatever had already streamed before the error so the user
        // doesn't lose the in-progress answer when a stream is interrupted (e.g.
        // the connection dropped while the tab was backgrounded). Previously the
        // partial buffer was discarded and replaced with a bare error message,
        // so the output the user was reading would vanish mid-reply.
        await appendMessages(launchConversationId, [buildStreamFailureMessage(buf, String(errMsg))]);
      }
      updateTurn(launchConversationId, controller, { status: "" });
    } finally {
      finishTurn(
        launchConversationId,
        controller,
        activeConversationIdRef.current !== launchConversationId,
      );
    }
  }

  return (
    <div className="chat-panel">
      <ChatErrorBoundary>
        <div
          className="chat-messages"
          ref={scrollRef}
          style={outputFormatStyle}
          onCopy={handleRenderedMathCopy}
        >
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
          {renderItems.map((item, itemIndex) => item.kind === "activity" ? (
            <AgentActivity
              key={item.key}
              activity={item}
              active={busy && !streaming && itemIndex === renderItems.length - 1}
            />
          ) : (
            <MessageRow
              key={item.key}
              msg={item.message}
              messageIndex={item.index}
              showPaperLinks={showPaperLinks}
              onOpenPaper={onOpenPaper}
              branchEnabled={c.type === "paper"}
              branchDisabled={busy}
              editDisabled={busy || (
                typeof c.branch_from_message_index === "number"
                && item.index <= c.branch_from_message_index
              )}
              onBranch={createBranch}
              onEdit={beginEditMessage}
            />
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
        onPaste={handlePaste}
        onAttach={() => fileInputRef.current?.click()}
        onDropFiles={handleDropFiles}
        busy={busy}
        placeholder={
          busy
            ? "…"
            : conv.type === "paper"
              ? "Ask anything about this paper or highlight text..."
              : "Ask about papers, topics, or sources..."
        }
        attachments={attachments}
        onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
        selectedTextContext={composerSelectedTextContext}
        selectedTextContextCanSubmitWithoutText={editingMessageIndex === null}
        onRemoveSelectedText={composerOnRemoveSelectedText}
        models={availableModels}
        currentModel={currentModel}
        onModelChange={handleModelChange}
        conversationId={c.id}
        systemPrompt={effectiveSystemPrompt}
        focusRequest={focusRequest}
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
  messageIndex,
  showPaperLinks,
  onOpenPaper,
  branchEnabled,
  branchDisabled,
  editDisabled,
  onBranch,
  onEdit,
}: {
  msg: ChatMessage;
  messageIndex: number;
  showPaperLinks: boolean;
  onOpenPaper: (paper: Paper) => void;
  branchEnabled: boolean;
  branchDisabled: boolean;
  editDisabled: boolean;
  onBranch: (messageIndex: number, excerpt: string) => Promise<void>;
  onEdit: (messageIndex: number, message: ChatMessage) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="msg msg-user">
        <Markdown enrichPaperLinks={false} children={msg.content ?? ""} />
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="msg-attachments">
            {msg.attachments.map((att, i) => (
              <img key={i} src={att.data_url} alt={att.name || "attachment"} className="msg-attachment-img" />
            ))}
          </div>
        )}
        <UserMessageActions
          text={msg.content ?? ""}
          editDisabled={editDisabled}
          onEdit={() => onEdit(messageIndex, msg)}
        />
      </div>
    );
  }
  if (msg.role === "tool") {
    const papers: Paper[] = msg.ui?.papers ?? [];
    if (!papers.length) return null;
    return (
      <div className="msg msg-tool">
        {showPaperLinks &&
          papers.map((p) => <PaperCard key={p.arxiv_id || p.doi || p.external_url || `p${papers.indexOf(p)}`} paper={p} onClick={() => onOpenPaper(p)} />)}
      </div>
    );
  }
  // assistant
  const content = (
    <>
      {msg.content ? (
        <Markdown>{msg.content}</Markdown>
      ) : (
        ""
      )}
      {msg.ui?.error && <div className="msg-error">{msg.ui.error}</div>}
      {msg.ui?.stopped && <div className="msg-stopped">已停止</div>}
    </>
  );
  if (!branchEnabled) {
    return <div className="msg msg-assistant">{content}</div>;
  }
  return (
    <AssistantBranchAction
      messageIndex={messageIndex}
      disabled={branchDisabled}
      onBranch={onBranch}
    >
      {content}
    </AssistantBranchAction>
  );
});
