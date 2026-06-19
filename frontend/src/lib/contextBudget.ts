// Context-budget domain logic for the context-usage ring.
//
// Pure functions only: no React, no IO, no store imports. The hard parts
// (capacity resolution, token estimation, calibration, tool-group-aware
// truncation) live here so they are fully unit-testable without rendering.
//
// Two consumers:
//   - components/ContextRing.tsx (via hooks/useContextBudget) — reads computeBudget
//     to render the ring + popover.
//   - components/ChatPanel.tsx — calls truncateToFit before sending each turn,
//     replacing the old message-count history slice.
//
// "Used" is a light CJK-aware heuristic estimate, calibrated against the
// provider's real `usage` after each turn (see computeCalibration). No bundled
// tokenizer: GLM's vocab isn't public, so a tokenizer would still be
// approximate; the heuristic + calibration is dependency-free and tracks
// ground truth well enough for a usage indicator.

import type { ChatMessage } from "../types";

export type CapacitySource = "override" | "detected" | "table" | "default";

/** Safe fallback when nothing else resolves. */
export const DEFAULT_CAPACITY = 128_000;

/** Selectable capacity presets. `value: 0` means Auto (resolve from model).
 *  256K and 1M are the common defaults users pick manually. */
export const CAPACITY_PRESETS = [
  { id: "auto", label: "Auto", value: 0 },
  { id: "32k", label: "32K", value: 32_000 },
  { id: "128k", label: "128K", value: 128_000 },
  { id: "256k", label: "256K", value: 256_000 },
  { id: "512k", label: "512K", value: 512_000 },
  { id: "1m", label: "1M", value: 1_000_000 },
  { id: "2m", label: "2M", value: 2_000_000 },
] as const;

/** Curated context-window sizes for well-known models. First substring match
 *  (case-insensitive, in array order) wins — so list more-specific prefixes
 *  before shorter ones (e.g. "gpt-4.1" before "gpt-4"). Low-maintenance. */
export const KNOWN_MODEL_CONTEXT: { match: string; tokens: number }[] = [
  { match: "glm-5", tokens: 128_000 }, // zai-org/glm-5.2 etc.
  { match: "gpt-4.1", tokens: 1_000_000 },
  { match: "gpt-4o", tokens: 128_000 },
  { match: "gpt-4-turbo", tokens: 128_000 },
  { match: "o1", tokens: 200_000 },
  { match: "o3", tokens: 200_000 },
  { match: "gemini-1.5", tokens: 2_000_000 },
  { match: "gemini-2", tokens: 1_000_000 },
  { match: "claude-3.5", tokens: 200_000 },
  { match: "claude-sonnet", tokens: 1_000_000 },
  { match: "deepseek", tokens: 64_000 },
  { match: "qwen", tokens: 32_000 },
  { match: "llama-3", tokens: 128_000 },
  { match: "mistral", tokens: 32_000 },
];

/** Resolve a model's total context capacity (tokens).
 *  Precedence: explicit override (>0) > model.context_length > KNOWN table > default.
 *  override === 0 / undefined means Auto (run the chain). */
export function resolveCapacity(
  model: { id: string; context_length?: number } | undefined,
  override: number | undefined
): { tokens: number; source: CapacitySource } {
  if (override && override > 0) {
    return { tokens: override, source: "override" };
  }
  if (model?.context_length && model.context_length > 0) {
    return { tokens: model.context_length, source: "detected" };
  }
  if (model?.id) {
    const id = model.id.toLowerCase();
    for (const entry of KNOWN_MODEL_CONTEXT) {
      if (id.includes(entry.match.toLowerCase())) {
        return { tokens: entry.tokens, source: "table" };
      }
    }
  }
  return { tokens: DEFAULT_CAPACITY, source: "default" };
}

/** Reserved output budget held back for the model's reply.
 *  12.5% of capacity (capacity / 8), floored at 4K, capped at 64K. */
export function defaultReserve(capacity: number): number {
  const r = Math.floor(capacity / 8);
  return Math.min(64_000, Math.max(4_000, r));
}

// ---------- token estimation ----------

/** CJK / Japanese / Korean Unicode ranges. CJK characters tokenize denser
 *  (~1.5 chars/token) than Latin (~4 chars/token). */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK symbols & punctuation
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) // CJK Compatibility Ideographs
  );
}

/** Estimate tokens for a plain string: ceil(cjk*1.5) + ceil(other/4). */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5) + Math.ceil(other / 4);
}

/** Flatten a message's content to plain text for estimation. Handles null,
 *  string, and OpenAI multimodal content arrays (text parts concatenated). */
function stringifyContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as unknown[])
      .map((p) =>
        p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? String((p as { text?: string }).text ?? "")
          : ""
      )
      .join("");
  }
  if (typeof content === "object") return JSON.stringify(content);
  return String(content);
}

/** Estimate tokens for a list of messages (the request that would be sent).
 *  = sum(estimateTextTokens(content)) + ~1024 per image + 4 per message
 *  (structural overhead OpenAI-style APIs charge for role tags/delimiters). */
export function estimateTokens(
  messages: { role: string; content: unknown }[]
): number {
  let textTokens = 0;
  let imgCount = 0;
  for (const m of messages) {
    textTokens += estimateTextTokens(stringifyContent(m.content));
    if (Array.isArray(m.content)) {
      for (const part of m.content as unknown[]) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "image_url"
        ) {
          imgCount++;
        }
      }
    }
  }
  return textTokens + imgCount * 1024 + 4 * messages.length;
}

// ---------- calibration from real usage ----------

/** Calibration factor = real.prompt_tokens / heuristicEstimate(that turn),
 *  clamped to [0.3, 3.0]. Returns 1 when the heuristic estimate is unusable. */
export function computeCalibration(
  realPromptTokens: number,
  heuristicEstimate: number
): number {
  if (!heuristicEstimate || heuristicEstimate <= 0) return 1;
  const ratio = realPromptTokens / heuristicEstimate;
  return Math.min(3.0, Math.max(0.3, ratio));
}

/** Apply a calibration factor to a fresh estimate. Undefined/0 calibration → 1.0
 *  (i.e. trust the raw heuristic before any real usage). */
export function calibratedEstimate(
  estimate: number,
  calibration: number | undefined
): number {
  const c = calibration && calibration > 0 ? calibration : 1;
  return Math.round(estimate * c);
}

// ---------- truncate-to-fit ----------

/** Group history into atomic, un-splittable units, preserving order.
 *  An assistant message carrying tool_calls is grouped with its immediately
 *  following `tool` result messages — OpenAI-compatible APIs reject a request
 *  whose tool messages don't all trace back to a tool_call, so a unit must be
 *  dropped whole or kept whole. Every other message is its own unit. */
function groupUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const unit: ChatMessage[] = [m];
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") {
        unit.push(messages[j]);
        j++;
      }
      units.push(unit);
      i = j;
    } else {
      units.push([m]);
      i++;
    }
  }
  return units;
}

/** Drop oldest history from the front until the estimated request
 *  (systemPrompt + surviving history) fits within (capacity - reserve).
 *  systemPrompt is a FIXED, un-droppable prefix — always counted, never
 *  truncated (in paper chats it carries the full PDF text and dominates).
 *  Whole tool-group units are dropped atomically; the last unit is always kept
 *  (best effort) so the latest exchange context survives. If even the system
 *  prompt alone exceeds the usable budget, returns history unchanged (the
 *  request will likely error, but we don't silently drop the user's turn). */
export function truncateToFit(
  messages: ChatMessage[],
  capacity: number,
  reserve: number,
  systemPrompt: string,
  calibration?: number
): { messages: ChatMessage[]; dropped: number } {
  const sysCost = calibratedEstimate(
    estimateTextTokens(systemPrompt) + 4, // +4 for the system message's structural overhead
    calibration
  );
  const budget = capacity - reserve - sysCost;
  if (budget <= 0) {
    // System prompt alone fills/exceeds usable budget — can't truncate our way out.
    return { messages: [...messages], dropped: 0 };
  }

  const units = groupUnits(messages);
  const unitCost = (u: ChatMessage[]) =>
    calibratedEstimate(estimateTokens(u), calibration);

  // Drop whole units from the front until the remainder fits; never drop the
  // last unit (keeps the latest exchange). Re-evaluate the running total each
  // step so we stop as soon as it fits.
  let start = 0;
  while (units.length - start > 1) {
    let total = 0;
    for (let k = start; k < units.length; k++) total += unitCost(units[k]);
    if (total <= budget) break;
    start++;
  }

  const kept = units.slice(start).flat();
  return { messages: kept, dropped: messages.length - kept.length };
}

// ---------- budget for the ring ----------

export interface Budget {
  used: number; // calibrated estimate of the request actually sent (system + truncated history)
  total: number; // resolved capacity
  reserve: number; // reserved output budget
  usable: number; // total - reserve
  pct: number; // used / usable, clamped 0..1
  status: "ok" | "warn" | "critical"; // warn >0.80, critical >0.95
  source: CapacitySource;
  /** History messages dropped from the front to fit (tool-group units, atomic).
   *  0 when the full history fits. The ring reflects the TRUNCATED request, so
   *  it never shows >100% of usable; this count tells the user old context is
   *  being trimmed on send. */
  dropped: number;
}

/** Resolve capacity + reserve for a conversation in one call. Returns the
 *  concrete numbers both the ring and the truncator need. */
export function resolveForConv(args: {
  model: { id: string; context_length?: number } | undefined;
  capacityOverride?: number;
  reserveOverride?: number;
}): { capacity: number; reserve: number; source: CapacitySource } {
  const { tokens: capacity, source } = resolveCapacity(
    args.model,
    args.capacityOverride
  );
  const reserve =
    args.reserveOverride && args.reserveOverride > 0
      ? args.reserveOverride
      : defaultReserve(capacity);
  return { capacity, reserve, source };
}

/** Compute the ring's budget. `used` is the calibrated estimate of the *next*
 *  request (systemPrompt + current history, before truncation). */
export function computeBudget(args: {
  messages: ChatMessage[];
  systemPrompt: string;
  model: { id: string; context_length?: number } | undefined;
  capacityOverride?: number;
  reserveOverride?: number;
  calibration?: number;
}): Budget {
  const { tokens: total, source } = resolveCapacity(
    args.model,
    args.capacityOverride
  );
  const reserve =
    args.reserveOverride && args.reserveOverride > 0
      ? args.reserveOverride
      : defaultReserve(total);
  const usable = Math.max(0, total - reserve);
  // The request actually sent: history truncated to fit (system prompt is a
  // fixed cost). The ring reflects the REAL request, so it never shows >100%
  // of usable — when history exceeds capacity, oldest tool-group units are
  // dropped on send and `dropped` reports how many messages were trimmed.
  const { messages: truncated, dropped } = truncateToFit(
    args.messages,
    total,
    reserve,
    args.systemPrompt,
    args.calibration
  );
  const raw = estimateTokens([
    { role: "system", content: args.systemPrompt },
    ...truncated,
  ]);
  const used = calibratedEstimate(raw, args.calibration);
  const pct = usable > 0 ? Math.min(1, used / usable) : 1;
  const status: Budget["status"] =
    pct > 0.95 ? "critical" : pct > 0.8 ? "warn" : "ok";
  return { used, total, reserve, usable, pct, status, source, dropped };
}

// ---------- display helpers ----------

/** Format a token count for display: 128000 → "128K", 48200 → "48.2K",
 *  1000000 → "1M", 1500000 → "1.5M", 999 → "999". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return (Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, "")) + "M";
  }
  if (n >= 1000) {
    const k = n / 1000;
    return (Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, "")) + "K";
  }
  return String(Math.round(n));
}
