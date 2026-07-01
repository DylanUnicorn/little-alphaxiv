// API client for the backend CORS proxy. All calls go to /api/* which Vite
// proxies to the FastAPI backend in dev. Keys live in the browser; the proxy
// is stateless.

import type { Paper, Provider, ModelInfo, TokenUsage, Conversation, Annotation } from "../types";

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
      // Auth-aware: the backend resolves the provider row by id (or the user's
      // default if null) and decrypts the stored api_key server-side. The
      // plaintext key never crosses the wire from the browser anymore.
      provider_id: provider.id,
      payload,
    }),
    credentials: "include",
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
      provider_id: provider.id,
      payload,
    }),
    credentials: "include",
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
): Promise<{ results: any[]; configured: boolean; message?: string }> {
  const r = await fetch(
    `${BASE}/api/websearch?q=${encodeURIComponent(query)}&max_results=${maxResults}`
  );
  if (!r.ok) throw new Error(`websearch error ${r.status}`);
  return r.json();
}

/** Fetch a single arXiv paper's metadata by id (title/authors/abstract/DOI/
 *  published/category) via the backend's /api/paper endpoint. Used to populate
 *  a paper record that was opened by direct URL navigation and only cached as a
 *  bare-id stub — so the chat title, sidebar, and Zotero "add paper" all see
 *  real metadata instead of `title = arxivId`. Returns the Paper (with an extra
 *  `updated` field that callers ignore). Throws on non-200 / not-found. */
export async function fetchPaperMeta(arxivId: string): Promise<Paper> {
  const r = await fetch(`${BASE}/api/paper?arxiv_id=${encodeURIComponent(arxivId)}`);
  if (!r.ok) throw new Error(`arxiv paper fetch error ${r.status}`);
  const data = await r.json();
  return data.paper as Paper;
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

/** Fetch available models from the user's provider via the backend proxy.
 *  Auth-aware: takes a provider_id (not inline base_url/api_key); the backend
 *  resolves the provider row, decrypts the key, and forwards to {base_url}/models. */
export async function fetchModels(providerId: string): Promise<ModelInfo[]> {
  const r = await fetch(
    `${BASE}/api/models?provider_id=${encodeURIComponent(providerId)}`,
    { credentials: "include" }
  );
  if (!r.ok) throw new Error(`models error ${r.status}`);
  const data = await r.json();
  return normalizeModels(data);
}

/** Test-fetch /models for credentials typed in the Add-provider form (before the
 *  provider is saved). The plaintext key is in the request body — same exposure
 *  as the save flow, and it's the authenticated owner. */
export async function testModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const r = await fetch(`${BASE}/api/models/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
    credentials: "include",
  });
  if (!r.ok) throw new Error(`models test error ${r.status}`);
  return normalizeModels(await r.json());
}

function normalizeModels(data: any): ModelInfo[] {
  const raw = (data.data || data.models || []) as Array<Record<string, unknown>>;
  // Pick the standard /v1/models fields plus a context-length if the provider
  // exposes one (PPIO and other OpenAI-compatible gateways sometimes do, under
  // a few different key names).
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

// ---------------------------------------------------------------------------
// Zotero — all calls go through /api/zotero/* (the backend proxies to either
// the local Zotero desktop API on 127.0.0.1:23119 or the web API at
// api.zotero.org). Credentials arrive per-request from the settings store.
// ---------------------------------------------------------------------------
export interface ZoteroCreds {
  mode: "auto" | "local" | "web";
  userId: string;
  apiKey: string;
}

export interface ZoteroItem {
  key: string;
  title: string;
  creators: string;
  itemType: string;
  year: string;
  date: string;
  url: string;
  doi: string;
  arxivId: string;
  abstract: string;
  collections: string[];
  tags: string[];
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentKey: string;
  numItems: number;
}

function zoteroParams(c: ZoteroCreds, extra: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams({ mode: c.mode, user_id: c.userId, api_key: c.apiKey });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p;
}

async function zoteroGet(path: string, c: ZoteroCreds, extra: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/api/zotero/${path}?${zoteroParams(c, extra).toString()}`);
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`zotero ${path} error ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function zoteroPost(path: string, body: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/zotero/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`zotero ${path} error ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

/** Check Zotero connectivity. Returns {ok, mode, library?, error?}. */
export async function zoteroStatus(c: ZoteroCreds): Promise<{ ok: boolean; mode: string; library?: string; error?: string }> {
  return zoteroGet("status", c);
}

/** Search/list Zotero items. Empty `q` lists recent items.
 *  `qmode` defaults to "everything" (full-text — searches all fields incl. the
 *  `extra` arXiv-id line), which is what the library Search box wants. Pass
 *  "titleCreatorYear" for title/author/year-only matching: it is ~0.5s vs
 *  everything's 1-30s cold-cache cost, and for an exact-title lookup it is the
 *  more precise net (everything can match the title string inside the abstract,
 *  which the caller's exact-title filter then rejects anyway). */
export async function zoteroSearchItems(
  c: ZoteroCreds,
  q: string,
  limit = 25,
  qmode: "everything" | "titleCreatorYear" = "everything"
): Promise<{ total: number; results: ZoteroItem[]; mode: string }> {
  return zoteroGet("items", c, { q, limit: String(limit), qmode: q ? qmode : "" });
}

/** List Zotero collections. */
export async function zoteroListCollections(c: ZoteroCreds): Promise<{ results: ZoteroCollection[]; mode: string }> {
  return zoteroGet("collections", c);
}

/** List the items directly inside a single collection — used when the user
 *  expands a collection row in the Collections tab to see the papers it holds.
 *  The backend /api/zotero/items endpoint already accepts a collection_key
 *  query param and routes it to /users/<seg>/collections/<key>/items, so this
 *  is a read in BOTH local and web mode (the local API is read-only but reads
 *  are allowed). Empty `q` lists every item in the collection. */
export async function zoteroListCollectionItems(
  c: ZoteroCreds,
  collectionKey: string,
  limit = 100
): Promise<{ total: number; results: ZoteroItem[]; mode: string }> {
  return zoteroGet("items", c, { collection_key: collectionKey, limit: String(limit) });
}

/** Create a Zotero collection (web mode only). */
export async function zoteroCreateCollection(
  c: ZoteroCreds,
  name: string,
  parentKey = ""
): Promise<{ ok: boolean; key?: string }> {
  return zoteroPost("collections", { mode: c.mode, user_id: c.userId, api_key: c.apiKey, name, parent_key: parentKey });
}

/** Add a Zotero item to collection(s) (web mode only). */
export async function zoteroAddToCollection(
  c: ZoteroCreds,
  itemKey: string,
  collectionKeys: string[]
): Promise<{ ok: boolean; collections: string[] }> {
  return zoteroPost(`items/${encodeURIComponent(itemKey)}/collections`, {
    mode: c.mode, user_id: c.userId, api_key: c.apiKey, collection_keys: collectionKeys,
  });
}

/** Create-or-update the paper's annotations child note in Zotero (web only).
 *  Powers "Create Note from Annotations": the backend patches the cached
 *  `noteKey` if still valid, else discovers an existing tagged child note under
 *  `parentKey`, else creates one — so repeated calls are idempotent across
 *  sessions. `noteKey` is an optional hint from a prior successful sync.
 *  Returns {ok, key, created, mode, error?}. */
export async function zoteroUpsertNote(
  c: ZoteroCreds,
  parentKey: string,
  html: string,
  opts: { noteKey?: string; tag?: string } = {}
): Promise<{ ok: boolean; key?: string; created?: boolean; mode: string; error?: string }> {
  return zoteroPost(`items/${encodeURIComponent(parentKey)}/note`, {
    mode: c.mode, user_id: c.userId, api_key: c.apiKey, html,
    note_key: opts.noteKey || "", tag: opts.tag || "little-alphaxiv-annotations",
  });
}

/** Save the current arXiv paper to Zotero (metadata + optional PDF + child
 *  note). The paper object matches the app's Paper record (arxiv_id, title,
 *  authors, doi, abstract, abs_url, published, primary_category). The backend
 *  fills any missing fields from arXiv, so a bare-id stub still yields a
 *  complete item. `collectionKeys` (web mode only) places the new item directly
 *  into the given collection(s) at creation time; the local connector can't
 *  target a collection and ignores it. Returns {ok, mode, key?, pdfAttached?,
 *  noteAdded?}. */
export async function zoteroSaveArxiv(
  c: ZoteroCreds,
  paper: { arxiv_id?: string; title?: string; authors?: string[]; doi?: string; abstract?: string; abs_url?: string; published?: string; pdf_url?: string; primary_category?: string },
  attachPdf: boolean,
  collectionKeys: string[] = []
): Promise<{ ok: boolean; mode: string; key?: string; pdfAttached?: boolean; noteAdded?: boolean }> {
  return zoteroPost("save-arxiv", { mode: c.mode, user_id: c.userId, api_key: c.apiKey, paper, attach_pdf: attachPdf, collection_keys: collectionKeys });
}

/** Local mode only: the Zotero desktop's currently-selected save target, so
 *  the UI can show where a new item will land (the connector always saves into
 *  the desktop's selected collection). Returns {ok, mode, libraryName?,
 *  collectionName?, collectionId?, error?}. Web mode returns empty names. */
export async function zoteroGetSelectedCollection(
  c: ZoteroCreds
): Promise<{ ok: boolean; mode: string; libraryName?: string; collectionName?: string; collectionId?: string | null; error?: string }> {
  return zoteroGet("selected-collection", c);
}

/** Build a zotero://select deep link that opens an item in the Zotero desktop
 *  app (the user library). Works for both local and web modes — the item key
 *  is the same in a synced library. */
export function zoteroSelectUrl(itemKey: string): string {
  return `zotero://select/library/items/${itemKey}`;
}

// ---------------------------------------------------------------------------
// Auth + persistence (server-side, per-user). All calls send credentials:
// "include" so the httpOnly lax_session cookie travels with them.
// ---------------------------------------------------------------------------

export interface Me {
  id: number;
  username: string;
  email: string | null;
  hasData: boolean;
}

async function jfetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, credentials: "include" });
}

export async function register(username: string, email: string, password: string): Promise<Me> {
  const r = await jfetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function login(username: string, password: string): Promise<Me> {
  const r = await jfetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function logout(): Promise<void> {
  await jfetch("/api/auth/logout", { method: "POST" });
}

export async function getMe(): Promise<Me | null> {
  const r = await jfetch("/api/auth/me");
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

/** Request a password-reset link. The backend ALWAYS returns a generic success
 *  (anti-enumeration), so this resolves even for unknown identifiers. */
export async function requestPasswordReset(identifier: string): Promise<void> {
  await jfetch("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier }),
  });
}

/** Reset the password with a token from a reset link. On success the backend
 *  sets a fresh session cookie (auto-login) and returns Me. */
export async function resetPassword(token: string, newPassword: string): Promise<Me> {
  const r = await jfetch("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

/** Set or clear the authenticated user's recovery email. Pass null to clear. */
export async function setAccountEmail(email: string | null): Promise<{ email: string | null }> {
  const r = await jfetch("/api/auth/account", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

// ---- providers ----

export interface ProviderOut {
  id: string;
  name: string;
  base_url: string;
  api_key: string; // MASKED (first4…last4) — never the plaintext
  model: string;
  vision_model?: string | null;
  is_default: boolean;
}

export async function listProviders(): Promise<ProviderOut[]> {
  const r = await jfetch("/api/providers");
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function addProvider(body: {
  id?: string; // frontend-generated; server uses it as the PK
  name: string; base_url: string; api_key: string; model: string;
  vision_model?: string | null; is_default?: boolean;
}): Promise<ProviderOut> {
  const r = await jfetch("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function updateProvider(id: string, body: Partial<{
  name: string; base_url: string; api_key: string; model: string;
  vision_model: string | null; is_default: boolean;
}>): Promise<ProviderOut> {
  const r = await jfetch(`/api/providers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function removeProvider(id: string): Promise<void> {
  const r = await jfetch(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await errText(r));
}

export async function setDefaultProvider(id: string): Promise<ProviderOut> {
  const r = await jfetch(`/api/providers/${encodeURIComponent(id)}/default`, { method: "POST" });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

// ---- settings (non-provider slice) ----

export interface SettingsOut {
  theme: string;
  searchSources: {
    openalex: { enabled: boolean; apiKey: string; email: string };
    semanticScholar: { enabled: boolean; apiKey: string };
  };
  zotero: { mode: "auto" | "local" | "web"; userId: string; apiKey: string };
  providerModels: Record<string, ModelInfo[]>;
}

export async function getSettings(): Promise<SettingsOut> {
  const r = await jfetch("/api/settings");
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function patchSettings(body: Partial<SettingsOut>): Promise<SettingsOut> {
  const r = await jfetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

// ---- conversations ----

export type ConversationSummary = Omit<Conversation, "messages">;

export async function listConversations(): Promise<ConversationSummary[]> {
  const r = await jfetch("/api/conversations");
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function getConversation(id: string): Promise<Conversation> {
  const r = await jfetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function putConversation(conv: Conversation): Promise<Conversation> {
  const r = await jfetch(`/api/conversations/${encodeURIComponent(conv.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conv),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function deleteConversation(id: string): Promise<void> {
  const r = await jfetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await errText(r));
}

// ---- annotations ----

export async function listAnnotations(arxivId: string): Promise<Annotation[]> {
  const r = await jfetch(`/api/annotations?arxiv_id=${encodeURIComponent(arxivId)}`);
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function putAnnotation(a: Annotation): Promise<Annotation> {
  const r = await jfetch(`/api/annotations/${encodeURIComponent(a.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(a),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function deleteAnnotation(id: string): Promise<void> {
  const r = await jfetch(`/api/annotations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await errText(r));
}

export async function clearAnnotations(arxivId: string): Promise<void> {
  const r = await jfetch(`/api/annotations?arxiv_id=${encodeURIComponent(arxivId)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await errText(r));
}

// ---- papers (global cache) ----

export type StoredPaper = Paper & { full_text?: string; fetched_at: number };

export async function getPaper(arxivId: string): Promise<StoredPaper | null> {
  const r = await jfetch(`/api/papers/${encodeURIComponent(arxivId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function putPaper(p: StoredPaper): Promise<StoredPaper> {
  const r = await jfetch(`/api/papers/${encodeURIComponent(p.arxiv_id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

// ---- local paper uploads (user-private PDFs: uploads + Zotero imports) ----

export interface UploadResult {
  paper_id: string;
  title: string;
  authors: string[];
  abstract: string;
  doi: string | null;
  source: string;
  external_url: string | null;
  full_text: string | null; // always null here — private; read via getPaper
  fetched_at: number;
  is_new: boolean; // False when a per-user content-hash dedup hit returned the existing row
}

/** URL for a user-uploaded / Zotero-imported PDF, served auth-gated through the
 *  backend. The serve route uses a :path converter so DOI-keyed ids (which
 *  contain '/') go in verbatim — no encodeURIComponent. */
export function paperUploadUrl(paperId: string): string {
  return `${BASE}/api/paper-upload/${paperId}`;
}

/** Upload a local PDF (with optional parsed metadata) and create a user-private
 *  paper. Returns the paper id + the metadata the backend stored. */
export async function uploadPaper(opts: {
  file: File;
  title?: string;
  authors?: string[];
  abstract?: string;
  doi?: string;
}): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", opts.file);
  if (opts.title) form.append("title", opts.title);
  if (opts.authors) form.append("authors_json", JSON.stringify(opts.authors));
  if (opts.abstract) form.append("abstract", opts.abstract);
  if (opts.doi) form.append("doi", opts.doi);
  const r = await jfetch("/api/paper-upload", { method: "POST", body: form });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

/** Import a PDF from a Zotero item into the app (user-private). When
 *  attachmentKey is omitted the backend picks the largest PDF attachment;
 *  a 400 means the item had no PDF attachment (caller should prompt manual
 *  upload). */
export async function importFromZotero(
  itemKey: string,
  attachmentKey?: string
): Promise<UploadResult> {
  const r = await jfetch("/api/paper-upload/import-from-zotero", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_key: itemKey, attachment_key: attachmentKey ?? null }),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

/** List a Zotero item's PDF attachments (for the import picker). */
export async function listZoteroAttachments(itemKey: string): Promise<{
  results: Array<{ key: string; title: string; contentType: string; fileSize: number; linkMode: string }>;
  mode: string;
}> {
  const r = await jfetch(`/api/zotero/items/${encodeURIComponent(itemKey)}/attachments`);
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

// ---- one-time browser → server migration ----

export interface MigratePayload {
  conversations: Conversation[];
  papers: StoredPaper[];
  annotations: Annotation[];
  settings: {
    providers: Array<{ id: string; name: string; base_url: string; api_key: string; model: string; vision_model?: string | null; is_default?: boolean }>;
    defaultProviderId: string | null;
    theme: string | null;
    searchSources: SettingsOut["searchSources"] | null;
    zotero: SettingsOut["zotero"] | null;
    providerModels: Record<string, ModelInfo[]> | null;
  } | null;
  zoteroNoteSync: Record<string, {
    enabled: boolean; note_key: string | null; parent_key: string | null;
    last_synced_at: number | null; last_error: string | null;
    last_count: number; content_sig: string | null;
  }> | null;
}

export async function importLocalData(payload: MigratePayload): Promise<{ imported: Record<string, number> }> {
  const r = await jfetch("/api/migrate/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

async function errText(r: Response): Promise<string> {
  const t = await r.text().catch(() => "");
  return `${r.status}: ${t.slice(0, 300)}`;
}

// ---- zotero note-sync state (per-user, per-paper) ----

export interface NoteSyncOut {
  enabled: boolean;
  noteKey: string | null;
  parentKey: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  lastCount: number;
  contentSig: string | null;
}

export async function listNoteSync(): Promise<Record<string, NoteSyncOut>> {
  const r = await jfetch("/api/zotero-note-sync");
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}

export async function putNoteSync(arxivId: string, patch: Partial<NoteSyncOut>): Promise<NoteSyncOut> {
  const r = await jfetch(`/api/zotero-note-sync/${encodeURIComponent(arxivId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(await errText(r));
  return r.json();
}
