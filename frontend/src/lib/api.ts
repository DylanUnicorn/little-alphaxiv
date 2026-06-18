// API client for the backend CORS proxy. All calls go to /api/* which Vite
// proxies to the FastAPI backend in dev. Keys live in the browser; the proxy
// is stateless.

import type { Paper, Provider, ModelInfo } from "../types";

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

  return { content, tool_calls: toolCalls, finish_reason: finishReason };
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
  return (data.data || data.models || []) as ModelInfo[];
}
