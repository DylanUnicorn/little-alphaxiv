// API client for the backend CORS proxy. All calls go to /api/* which Vite
// proxies to the FastAPI backend in dev. Keys live in the browser; the proxy
// is stateless.

import type { Paper, Provider, ModelInfo, TokenUsage } from "../types";

const BASE = ""; // same-origin in dev via Vite proxy

/** Stream a chat completion from the user's configured provider.
 *  Calls onDelta(token) for each streamed text token.
 *  Returns the final parsed message (content + tool_calls) once the stream ends. */
export interface StreamResult {
  content: string;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  finish_reason: string | null;
  /** Token usage reported by the provider on the final stream chunk, if any.
   *  Used to calibrate the context-usage ring's estimate. Undefined when the
   *  provider doesn't emit usage (graceful — the ring falls back to estimate). */
  usage?: TokenUsage;
}

export async function streamChat(opts: {
  provider: Provider;
  messages: unknown[];
  tools?: unknown[];
  model?: string;
  signal?: AbortSignal;
  onDelta?: (token: string) => void;
  onReasoning?: (token: string) => void;
  onToolCallDelta?: (name: string, argsDelta: string) => void;
}): Promise<StreamResult> {
  const { provider, messages, tools, model: modelOverride, signal, onDelta, onReasoning, onToolCallDelta } = opts;

  const payload: Record<string, unknown> = {
    // Honor the per-conversation model override (e.g. a vision model the user
    // picked for image chat); fall back to the provider default. Previously
    // this was hardcoded to provider.model, silently dropping the override —
    // which sent image turns to a non-vision default and made providers reject
    // the attachment with "does not support image".
    model: modelOverride || provider.model,
    messages,
    stream: true,
    // Ask the provider to report token usage on the final chunk. The
    // context-usage ring calibrates its heuristic estimate against this. The
    // /api/llm proxy forwards payload verbatim, so this passes through
    // unchanged; providers that ignore stream_options simply won't emit usage
    // (graceful — usage stays undefined).
    stream_options: { include_usage: true },
  };
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  const resp = await fetch(`${BASE}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_url: provider.base_url,
      api_key: provider.api_key,
      payload,
    }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM proxy error ${resp.status}: ${text.slice(0, 300)}`);
  }

  return parseSSE(resp.body, onDelta, onToolCallDelta, onReasoning);
}

/** Non-streaming chat completion from the user's configured provider.
 *  Used for short, single-shot calls (e.g. generating a conversation title)
 *  where the streaming/SSE overhead isn't worth it. The /api/llm proxy forwards
 *  `stream:false` and returns the upstream JSON verbatim.
 *  Returns the assistant's text content ("" if absent). */
export async function completeChat(opts: {
  provider: Provider;
  messages: unknown[];
  model?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { provider, messages, model: modelOverride, signal } = opts;

  const payload: Record<string, unknown> = {
    // Honor per-conversation model override; fall back to provider default
    // (same precedence as streamChat).
    model: modelOverride || provider.model,
    messages,
    stream: false,
  };

  const resp = await fetch(`${BASE}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_url: provider.base_url,
      api_key: provider.api_key,
      payload,
    }),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM proxy error ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === "string" ? content : "";
}

/** Parse the OpenAI SSE stream. Accumulates content + tool_call argument
 *  fragments across chunks (OpenAI streams tool args in pieces). */
async function parseSSE(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (t: string) => void,
  onToolCallDelta?: (name: string, args: string) => void,
  onReasoning?: (t: string) => void
): Promise<StreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  // tool calls indexed by their position in the delta.tool_calls array
  const toolCalls: StreamResult["tool_calls"] = [];
  let finishReason: string | null = null;
  let usage: TokenUsage | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      // error event injected by the proxy on upstream failure
      if (json.error) {
        throw new Error(
          `upstream error${json.status ? ` ${json.status}` : ""}: ${
            (json.body || json.message || "").slice(0, 300)
          }`
        );
      }
      // Token usage arrives on the final chunk (often with choices: []), so it
      // is captured independently of the choices block below. Providers that
      // don't emit usage simply leave it undefined.
      if (json.usage) {
        usage = {
          prompt_tokens: Number(json.usage.prompt_tokens) || 0,
          completion_tokens: Number(json.usage.completion_tokens) || 0,
          total_tokens: Number(json.usage.total_tokens) || 0,
        };
      }
      if (json.choices && json.choices.length) {
        const choice = json.choices[0];
        const delta = choice.delta ?? {};
        // GLM/zai streams a separate "reasoning_content" chain before the real
        // content. We surface it as a "thinking" status, not as the answer.
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          onReasoning?.(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onDelta?.(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name)
              toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) {
              toolCalls[idx].function.arguments += tc.function.arguments;
              onToolCallDelta?.(
                toolCalls[idx].function.name,
                tc.function.arguments
              );
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  return { content, tool_calls: toolCalls, finish_reason: finishReason, usage };
}

/** arXiv search via the backend proxy. */
export async function searchArxiv(
  query: string,
  maxResults = 8
): Promise<{ total: number; results: Paper[] }> {
  const r = await fetch(
    `${BASE}/api/search?q=${encodeURIComponent(query)}&max_results=${maxResults}`
  );
  if (!r.ok) throw new Error(`arxiv search error ${r.status}`);
  return r.json();
}

/** OpenAlex search via the backend proxy. */
export async function searchOpenAlex(
  query: string,
  maxResults = 8,
  opts: { apiKey?: string; email?: string } = {}
): Promise<{ total: number; results: Paper[] }> {
  const params = new URLSearchParams({
    q: query,
    max_results: String(maxResults),
  });
  if (opts.apiKey) params.set("api_key", opts.apiKey);
  if (opts.email) params.set("email", opts.email);
  const r = await fetch(`${BASE}/api/openalex?${params.toString()}`);
  if (!r.ok) throw new Error(`openalex search error ${r.status}`);
  return r.json();
}

/** Semantic Scholar search via the backend proxy. */
export async function searchSemanticScholar(
  query: string,
  maxResults = 8,
  apiKey?: string
): Promise<{ total: number; results: Paper[] }> {
  const params = new URLSearchParams({
    q: query,
    max_results: String(maxResults),
  });
  if (apiKey) params.set("api_key", apiKey);
  const r = await fetch(`${BASE}/api/semantic_scholar?${params.toString()}`);
  if (!r.ok) throw new Error(`semantic scholar search error ${r.status}`);
  return r.json();
}

/** General web search via anysearch MCP (backend). */
export async function webSearch(
  query: string,
  maxResults = 8
): Promise<{ results: any[]; configured: boolean }> {
  const r = await fetch(
    `${BASE}/api/websearch?q=${encodeURIComponent(query)}&max_results=${maxResults}`
  );
  if (!r.ok) throw new Error(`websearch error ${r.status}`);
  return r.json();
}

/** URL for a paper's PDF, served through the backend proxy (CORS + cache). */
export function pdfUrl(arxivId: string): string {
  return `${BASE}/api/pdf/${encodeURIComponent(arxivId)}`;
}

/** URL for an arbitrary open-access PDF, served through the backend open proxy
 *  (CORS + cache + SSRF guard). Used by non-arXiv results that carry oa_pdf_url. */
export function pdfUrlForOa(url: string): string {
  return `${BASE}/api/pdf-url?url=${encodeURIComponent(url)}`;
}

/** Fetch available models from the user's provider via the backend proxy. */
export async function fetchModels(
  baseUrl: string,
  apiKey: string
): Promise<ModelInfo[]> {
  const r = await fetch(
    `${BASE}/api/models?base_url=${encodeURIComponent(baseUrl)}&api_key=${encodeURIComponent(apiKey)}`
  );
  if (!r.ok) throw new Error(`models error ${r.status}`);
  const data = await r.json();
  const raw = (data.data || data.models || []) as Array<Record<string, unknown>>;
  // Pick the standard /v1/models fields plus a context-length if the provider
  // exposes one (PPIO and other OpenAI-compatible gateways sometimes do, under
  // a few different key names). Previously the `as ModelInfo[]` cast silently
  // discarded any extra fields, so detection never worked.
  return raw.map((m) => {
    const context_length = pickContextLength(m);
    return {
      id: String(m.id ?? ""),
      ...(m.object != null ? { object: String(m.object) } : {}),
      ...(m.created != null ? { created: Number(m.created) } : {}),
      ...(m.owned_by != null ? { owned_by: String(m.owned_by) } : {}),
      ...(context_length != null ? { context_length } : {}),
    } as ModelInfo;
  });
}

/** Read a model's total context length from whichever key the provider uses.
 *  Returns undefined when none is present (capacity then resolves via the
 *  curated table or default). */
function pickContextLength(m: Record<string, unknown>): number | undefined {
  for (const key of ["context_length", "max_context_tokens", "max_input_tokens", "max_context_length"]) {
    const v = m[key];
    if (typeof v === "number" && v > 0) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      const n = Number(v);
      if (n > 0) return n;
    }
  }
  return undefined;
}
