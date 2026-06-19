// Tool definitions + the client-side tool-calling loop.
//
// The backend is a dumb proxy; the LLM tool-calling loop runs HERE in the
// browser. The model gets two tools (search_arxiv, web_search). When it emits
// a tool_call, we execute it (calling /api/search or /api/websearch), append
// the result as a tool-role message, and re-stream — repeating until the
// model answers with plain text.

import { streamChat, completeChat, searchArxiv, webSearch } from "./api";
import type { ChatMessage, Paper, Provider, ToolDef, TokenUsage } from "../types";

export const SEARCH_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_arxiv",
      description:
        "Search arXiv for academic papers by keyword, topic, or author. " +
        "Returns matching papers with title, authors, abstract, and a clickable link to preview the PDF. " +
        "Use this when the user wants to find, discover, or read research papers. " +
        "The query should be concise search terms (e.g. 'vision transformer', 'chain of thought reasoning').",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms for arXiv. Concise keywords work best.",
          },
          max_results: {
            type: "number",
            description: "Max papers to return (default 8).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "General web search (via anysearch) for non-arXiv information: " +
        "recent news, blog posts, people, products, or anything not an academic paper. " +
        "Use search_arxiv for finding papers; use web_search for everything else.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Web search query." },
        },
        required: ["query"],
      },
    },
  },
];

interface LoopCallbacks {
  onAssistantStart?: () => void; // a new assistant message is beginning (clear stream buffer)
  onAssistantDelta?: (token: string) => void; // streaming token for current assistant message
  onAssistantMessage?: (msg: ChatMessage) => void; // an assistant message finalized
  onToolMessage?: (msg: ChatMessage) => void; // a tool-result message appended
  onPapers?: (papers: Paper[]) => void; // surfaced from search_arxiv results
  onStatus?: (status: string) => void;
  onReasoning?: (token: string) => void; // GLM reasoning_content tokens
  onUsage?: (usage: TokenUsage, requestMessages: unknown[]) => void; // provider token usage + the exact messages sent (calibrates the context ring)
}

/** Run a full conversation turn: stream the assistant response, executing any
 *  tool calls, until the model produces a final text answer. Returns the new
 *  messages to append (assistant messages + tool result messages). */
export async function runConversation(opts: {
  provider: Provider;
  messages: ChatMessage[];
  systemPrompt?: string;
  model?: string; // per-conversation model override
  signal?: AbortSignal;
  callbacks: LoopCallbacks;
}): Promise<{ newMessages: ChatMessage[] }> {
  const { provider, messages, systemPrompt, model: modelOverride, signal, callbacks } = opts;
  const effectiveModel = modelOverride || provider.model;

  // Build the message array sent to the model. Prepend system prompt.
  const apiMessages: unknown[] = [];
  if (systemPrompt)
    apiMessages.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    // strip UI-only fields before sending
    // For user messages with attachments, convert to OpenAI multimodal format
    if (m.role === "user" && m.attachments && m.attachments.length > 0) {
      const contentParts: unknown[] = [];
      if (m.content) contentParts.push({ type: "text", text: m.content });
      for (const att of m.attachments) {
        if (att.type === "image") {
          contentParts.push({
            type: "image_url",
            image_url: { url: att.data_url },
          });
        }
      }
      apiMessages.push({ role: "user", content: contentParts });
    } else {
      apiMessages.push({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      });
    }
  }

  const newMessages: ChatMessage[] = [];
  let guard = 0; // cap tool-call rounds to avoid infinite loops

  for (;;) {
    if (++guard > 6) break;
    callbacks.onAssistantStart?.();
    const result = await streamChat({
      provider,
      model: effectiveModel,
      messages: apiMessages,
      tools: SEARCH_TOOLS,
      signal,
      onDelta: (t) => callbacks.onAssistantDelta?.(t),
      onReasoning: (t) => callbacks.onReasoning?.(t),
    });

    // Provider-reported token usage (if any) — the context-usage ring
    // calibrates its heuristic estimate against this. Fired once per
    // streamChat call with the exact messages sent for that call, so the
    // caller's heuristic estimate matches the reported prompt_tokens. In a
    // tool loop the final turn's usage is what matters.
    if (result.usage) callbacks.onUsage?.(result.usage, apiMessages);

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: result.content || null,
      ...(result.tool_calls.length
        ? { tool_calls: result.tool_calls }
        : {}),
    };
    apiMessages.push(assistantMsg);
    newMessages.push(assistantMsg);
    callbacks.onAssistantMessage?.(assistantMsg);

    // No tool calls -> final answer, done.
    if (!result.tool_calls.length) break;

    // Execute each tool call and append results.
    for (const tc of result.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* keep empty args */
      }
      if (tc.function.name === "search_arxiv") {
        callbacks.onStatus?.("Searching arXiv…");
        const res = await searchArxiv(
          args.query ?? "",
          args.max_results ?? 8
        );
        callbacks.onPapers?.(res.results);
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: tc.id,
          name: "search_arxiv",
          content: JSON.stringify(res.results.slice(0, 8)),
          ui: { papers: res.results },
        };
        apiMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: "search_arxiv",
          content: JSON.stringify(res.results.slice(0, 8)),
        });
        newMessages.push(toolMsg);
        callbacks.onToolMessage?.(toolMsg);
      } else if (tc.function.name === "web_search") {
        callbacks.onStatus?.("Web searching…");
        const res = await webSearch(args.query ?? "", 8);
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: tc.id,
          name: "web_search",
          content: JSON.stringify(res.results),
        };
        apiMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: "web_search",
          content: JSON.stringify(res.results),
        });
        newMessages.push(toolMsg);
        callbacks.onToolMessage?.(toolMsg);
      } else {
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `unknown tool: ${tc.function.name}`,
        };
        apiMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `unknown tool: ${tc.function.name}`,
        });
        newMessages.push(toolMsg);
        callbacks.onToolMessage?.(toolMsg);
      }
    }
    // loop again: model will see tool results and either call more tools or answer
  }

  return { newMessages };
}

// ---------- Conversation title generation ----------
//
// The sidebar/history index used to be the user's first message truncated to
// 48 chars — too blunt. Instead we ask the configured model to summarize the
// first exchange (user question + assistant reply), grounded in the paper's
// title/abstract/text when it's a paper chat, into a short descriptive title.
//
// Design notes:
//   - Non-streaming, no tools: a title is a one-shot ~10-word string; the SSE
//     + tool-loop machinery of runConversation is wasted overhead here.
//   - Fires once, after the first turn completes (caller guards). On any
//     failure (no provider, network, bad output) it returns null and the
//     caller keeps the instant truncated-first-message fallback title.
//   - Never throws to the caller; title generation must never break a chat.

export interface TitlePaperContext {
  arxivId?: string;
  title?: string;
  abstract?: string;
  /** A short excerpt of the extracted PDF full text (caller trims). */
  fullTextSnippet?: string;
}

/** Generate a short descriptive title for a conversation from its first
 *  exchange. Returns null on any failure so callers can fall back. */
export async function generateConversationTitle(opts: {
  provider: Provider;
  model?: string;
  firstUserMessage: string;
  firstAssistantMessage: string;
  paperContext?: TitlePaperContext;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { provider, model, firstUserMessage, firstAssistantMessage, paperContext, signal } = opts;
  const userQ = (firstUserMessage || "").trim();
  const assistantA = (firstAssistantMessage || "").trim();
  if (!userQ && !assistantA) return null;

  const paperBlock = paperContext
    ? "\n\nPaper being discussed:\n" +
      `arxiv id: ${paperContext.arxivId ?? ""}\n` +
      `title: ${paperContext.title ?? ""}\n` +
      `abstract: ${(paperContext.abstract ?? "").slice(0, 1200)}\n` +
      `full text excerpt: ${(paperContext.fullTextSnippet ?? "").slice(0, 1500)}`
    : "";

  const system =
    "You are a title generator for a research-chat app (an alphaxiv-style reader). " +
    "Given a conversation's first exchange — a user question and the assistant's reply — " +
    "produce a concise descriptive title that captures what the conversation is about. " +
    "Rules: at most 10 words; plain text; no quotation marks; no trailing period; " +
    "no prefix such as 'Title:'; do not start with 'Discussion of' or 'Chat about'. " +
    "When paper context is provided, reflect the paper's topic. " +
    "Respond with the title only, nothing else.";

  const user =
    `User asked: ${userQ.slice(0, 1000)}\n\n` +
    `Assistant answered:\n${assistantA.slice(0, 2000)}${paperBlock}\n\n` +
    `Respond with only a short title.`;

  try {
    const raw = await completeChat({
      provider,
      model,
      signal,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return cleanTitle(raw);
  } catch {
    return null;
  }
}

/** Normalize a model's title output: strip quotes/labels, collapse whitespace,
 *  drop a trailing period, cap at ~80 chars on a word boundary. Returns null
 *  if nothing usable remains. */
export function cleanTitle(raw: string): string | null {
  let t = (raw || "").trim();
  if (!t) return null;
  // Strip a leading "Title:" label (model sometimes echoes the instruction).
  t = t.replace(/^title\s*[:：]\s*/i, "");
  // Strip surrounding quotation marks (straight + curly + guillemets).
  t = t.replace(/^["'“”«»]+|["'“”«»]+$/g, "");
  t = t.replace(/\s+/g, " ").trim();
  // Drop a trailing period.
  t = t.replace(/[.。]+$/, "").trim();
  if (!t) return null;
  if (t.length > 80) {
    const cut = t.slice(0, 80);
    const lastSpace = cut.lastIndexOf(" ");
    t = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return t;
}
