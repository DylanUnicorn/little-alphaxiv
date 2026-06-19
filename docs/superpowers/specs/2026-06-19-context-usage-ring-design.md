# Context Usage Ring + Real Model-Capacity Setting

**Date:** 2026-06-19
**Status:** Design (awaiting implementation plan)
**Scope:** Frontend only (backend passthrough proxy needs no changes)

## 1. Problem

The PDF-preview chat's right-sidebar ⚙ settings dropdown contains a field
labeled **"Context window (msgs, 0 = all)"** (`ChatToolbar.tsx:148-159`). It is
genuinely broken in three ways:

1. **Label lies.** The label says "msgs" but the type comment in
   `types.ts:84` says "max tokens"; neither matches user expectation of a
   "context window", which conventionally means the model's total context
   capacity.
2. **Semantics are opaque.** A bare 0–100 number input. `0 = all` and the
   invisible `max={100}` cap are unexplained. The setting does nothing to
   reflect or respect the model's *actual* context capacity.
3. **Disconnected from reality.** There is no concept anywhere in the codebase
   of a model's real context-window size. `ModelInfo` (`types.ts:90-96`)
   captures only `{id, object, created, owned_by}` — the `fetchModels`
   normalizer (`api.ts:190`) casts away any extra fields a provider returns
   (e.g. `context_length`). There is no token counting, no usage tracking; the
   SSE parser (`api.ts:113-192`) discards the upstream `usage` object.

The user wants:

- A **real model-capacity concept** — default selectable at **256K / 1M** (and
  a few other presets), with **best-effort auto-detection** from the model
  (whether PPIO exposes it is unknown; the design must not depend on it).
- A **small context-usage ring** mounted on the chat box that, when clicked,
  opens a popover showing **used / total / reserved** context.

## 2. Goals & Non-Goals

**Goals**

- Replace the confusing message-count input with a real token-capacity model.
- Show live context usage via a ring + popover on the chat panel.
- Auto-detect the model's context capacity when the provider exposes it; fall
  back to a curated table, then presets, then a safe default.
- Prevent context-overflow API errors on long chats by auto-truncating history
  to fit `capacity − reserve`.
- Measure "used" via provider-reported `usage` (ground truth) calibrated against
  a light client-side estimate (live signal between turns).
- Work in both the paper-view chat and the general chat (the `ChatPanel` is
  shared).
- Verify end-to-end with the existing keyless Playwright + mock-LLM rig (no
  real API key required).

**Non-Goals (v1)**

- A bundled tokenizer (e.g. js-tiktoken). GLM's tokenizer is not public, so it
  would still be approximate; the heuristic + provider-calibration is
  sufficient and dependency-free.
- Backend changes. `/api/llm` and `/api/models` are verbatim passthroughs, so
  `stream_options.include_usage` and any `context_length` field flow through
  unmodified.
- A separate ring UI for general chat vs paper chat — one shared `ContextRing`
  component mounted in `ChatPanel` covers both.
- Migration/rewrite of the dormant `context_window` field in IndexedDB. It is
  left in place unread.

## 3. Architecture

```
                 ┌─────────────────────────────────────────────┐
                 │  lib/contextBudget.ts  (pure, no React/IO)  │
                 │                                             │
                 │  resolveCapacity(model, override) -> tokens │
                 │  CAPACITY_PRESETS  /  KNOWN_MODEL_CONTEXT    │
                 │  defaultReserve(capacity)                    │
                 │  estimateTokens(messages) -> tokens          │
                 │  truncateToFit(messages, capacity, reserve)  │
                 │  computeBudget(...) -> Budget                │
                 │  applyCalibration(estimate, lastUsage)       │
                 └───────────────┬─────────────────────────────┘
                                 │ used by
              ┌──────────────────┼──────────────────────┐
              ▼                  ▼                      ▼
   hooks/useContextBudget   ChatPanel.send()      (unit tests)
   (reads conv + provider)  (auto-truncate)
              │
              ▼
   components/ContextRing.tsx   ◀── mounted in ChatPanel model-selector row
   (ring SVG + popover)
```

The domain logic is isolated in `lib/contextBudget.ts` — pure functions, no
React, no IO. This makes the hard parts (capacity resolution, truncation,
calibration) fully unit-testable without rendering anything.

## 4. Data Model (`types.ts`)

### 4.1 `ModelInfo` — add context length

```ts
export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_length?: number;   // NEW — if the provider's /v1/models returns it
}
```

`fetchModels` (`api.ts`) stops discarding extra fields: it explicitly picks
`context_length` (and any common aliases: `max_context_tokens`,
`max_input_tokens`) into each `ModelInfo`. Because the settings store caches
`ModelInfo[]` in localStorage (`providerModels`), detected capacities persist
across sessions for free.

### 4.2 `Conversation` — add capacity + usage fields

```ts
export interface Conversation {
  // ...existing fields...
  context_capacity_override?: number; // NEW — 0/undefined = Auto (resolve from model)
  reserve_tokens?: number;            // NEW — 0/undefined = auto default (12.5%)
  last_usage?: {                      // NEW — last turn's real usage (calibration source)
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    calibration: number;              // real.prompt_tokens / heuristicEstimate(that turn)
    ts: number;
  };
  context_window?: number;            // DEPRECATED — left dormant, unread, unmigrated
}
```

### 4.3 `updateSettings` patch (`store/conversations.ts`)

Widen the accepted patch:

```ts
updateSettings: (id: string, patch: {
  model?: string;
  style_preset?: StylePreset;
  context_window?: number;            // kept for back-compat (no UI writes it now)
  context_capacity_override?: number; // NEW
  reserve_tokens?: number;            // NEW
}) => Promise<void>;
```

Each new field is merged conditionally (same pattern as the existing
`context_window` merge at `conversations.ts:159`).

## 5. Pure Module — `lib/contextBudget.ts`

All exports are pure functions. No imports of React or the stores.

### 5.1 Capacity resolution chain

```ts
export const CAPACITY_PRESETS = [
  { id: "auto", label: "Auto", value: 0 },
  { id: "32k",  label: "32K",  value: 32_000 },
  { id: "128k", label: "128K", value: 128_000 },
  { id: "256k", label: "256K", value: 256_000 },
  { id: "512k", label: "512K", value: 512_000 },
  { id: "1m",   label: "1M",   value: 1_000_000 },
  { id: "2m",   label: "2M",   value: 2_000_000 },
] as const;

export const DEFAULT_CAPACITY = 128_000;

// Curated table of known models. First substring match (in array order) on
// the model id wins — order matters, so list more-specific prefixes first.
// Low-maintenance: ~15 entries covering the providers this app targets.
export const KNOWN_MODEL_CONTEXT: { match: string; tokens: number }[] = [
  { match: "glm-5",         tokens: 128_000 },   // zai-org/glm-5.2 etc.
  { match: "gpt-4.1",       tokens: 1_000_000 },
  { match: "gpt-4o",        tokens: 128_000 },
  { match: "gpt-4-turbo",   tokens: 128_000 },
  { match: "o1",            tokens: 200_000 },
  { match: "o3",            tokens: 200_000 },
  { match: "gemini-1.5",    tokens: 2_000_000 },
  { match: "gemini-2",      tokens: 1_000_000 },
  { match: "claude-3.5",    tokens: 200_000 },
  { match: "claude-sonnet", tokens: 1_000_000 },
  { match: "deepseek",      tokens: 64_000 },
  { match: "qwen",          tokens: 32_000 },
  { match: "llama-3",       tokens: 128_000 },
  { match: "mistral",       tokens: 32_000 },
];

/** Resolve a model's total context capacity (tokens).
 *  Precedence: explicit override > model.context_length > KNOWN table > default. */
export function resolveCapacity(
  model: { id: string; context_length?: number } | undefined,
  override: number | undefined
): { tokens: number; source: "override" | "detected" | "table" | "default" };
```

### 5.2 Reserved output budget

```ts
/** Output budget held back for the model's reply.
 *  12.5% of capacity, floored at 4K, capped at 64K. */
export function defaultReserve(capacity: number): number;
```

### 5.3 Token estimate (CJK-aware heuristic)

```ts
/** Estimate tokens for a list of messages (the request that would be sent).
 *  heuristic: ceil(cjkChars * 1.5) + ceil(otherChars / 4) + 4 * messageCount.
 *  No tokenizer dependency. */
export function estimateTokens(messages: { role: string; content: unknown }[]): number;
```

`4 * messageCount` approximates the per-message structural overhead OpenAI-style
APIs charge (role tags, delimiters). Content is stringified (multimodal content
arrays: text parts counted, image parts charged a fixed ~1K estimate).

### 5.4 Calibration from real usage

```ts
/** Compute a calibration factor: real.prompt_tokens / heuristicEstimate(thatTurn).
 *  Clamped to [0.3, 3.0]. Before any real usage, calibration = 1.0. */
export function computeCalibration(
  realPromptTokens: number,
  heuristicEstimate: number
): number;

/** Apply calibration to a fresh estimate. Falls back to 1.0. */
export function calibratedEstimate(estimate: number, calibration: number | undefined): number;
```

### 5.5 Truncate-to-fit (replaces message-count slice)

```ts
/** Drop oldest history messages from the front until the estimated request
 *  (systemPrompt + surviving history) fits within (capacity - reserve).
 *  systemPrompt is a FIXED, un-droppable prefix — it is always counted but
 *  never truncated. In paper chats it carries the full PDF text, so it is the
 *  dominant token consumer and MUST be included in the budget.
 *  Tool-group-aware: groups each assistant(tool_calls) + its immediately-
 *  following tool messages as an atomic unit and drops whole units only —
 *  never splits a tool_call from its results (OpenAI-compatible APIs reject
 *  orphaned tool messages with 400). Always keeps the most recent user
 *  message. If even systemPrompt alone exceeds the budget, returns the
 *  history unchanged (the request will likely error, but we don't silently
 *  drop the user's turn). */
export function truncateToFit(
  messages: ChatMessage[],
  capacity: number,
  reserve: number,
  systemPrompt: string,
  calibration?: number
): { messages: ChatMessage[]; dropped: number };
```

`systemPrompt` is treated as a fixed cost: the fit check estimates
`systemPrompt` once, subtracts that from the budget, then drops whole tool
units + ordinary messages from the front of `messages` until the remainder
fits. Because units are atomic, no `tool_call` id ever dangles — there is no
stripping step.

### 5.6 Budget for the ring

```ts
export interface Budget {
  used: number;       // calibrated estimate of the request actually sent (system + truncated history)
  total: number;      // resolved capacity
  reserve: number;    // reserved output budget
  usable: number;     // total - reserve
  pct: number;        // used / usable, clamped 0..1
  status: "ok" | "warn" | "critical"; // warn >0.80, critical >0.95
  source: "override" | "detected" | "table" | "default";
  dropped: number;    // history messages dropped to fit (0 when it all fits)
}

export function computeBudget(args: {
  messages: ChatMessage[];        // current history (truncated internally to fit)
  systemPrompt: string;           // FIXED prefix — counted, never truncated (paper full text lives here)
  model: { id: string; context_length?: number } | undefined;
  capacityOverride?: number;
  reserveOverride?: number;
  calibration?: number;
}): Budget;

/** Convenience: resolve capacity + reserve for a conversation in one call.
 *  Returns the concrete numbers the ring and the truncator both need. */
export function resolveForConv(args: {
  model: { id: string; context_length?: number } | undefined;
  capacityOverride?: number;
  reserveOverride?: number;
}): { capacity: number; reserve: number; source: Budget["source"] };
```

`used` is the calibrated estimate of the request actually sent (`systemPrompt` +
truncated history — `computeBudget` runs `truncateToFit` internally, so the ring
reflects the real request and never shows >100% of usable). The ring fills to
`pct`; color follows `status`. When `dropped > 0` the popover shows a
"N oldest messages truncated on send" note.

## 6. Capturing Real Usage

### 6.1 Request payload (`api.ts` `streamChat`)

Add `stream_options: { include_usage: true }` to the payload (alongside the
existing `stream: true`). Non-streaming `completeChat` already returns full
JSON including `usage` — no change needed there.

### 6.2 SSE parsing (`api.ts` `parseSSE`)

OpenAI-compatible streams emit the `usage` object on the **final** chunk, with
`choices: []`. Capture it:

```ts
export interface StreamResult {
  content: string;
  tool_calls: StreamResult["tool_calls"];
  finish_reason: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; // NEW
}
```

`parseSSE` records `json.usage` when present. If a provider never emits usage
(e.g. some gateways), `usage` stays `undefined` — graceful, no error.

### 6.3 Propagation (`llm.ts` `runConversation`)

Add `onUsage?: (usage) => void` to `LoopCallbacks`. Fire it once per
`streamChat` call that returns a `usage`. `ChatPanel.send()` persists it onto
the conversation as `last_usage` (computing `calibration` from the heuristic
estimate of that turn's `apiMessages`), via `updateSettings`.

## 7. UI — `components/ContextRing.tsx`

Self-contained component. Reads `useConversations` (active conv: messages,
`context_capacity_override`, `reserve_tokens`, `last_usage`, `model`) and
`useSettings` (active provider + its cached `ModelInfo` to read
`context_length`). It receives the **effective system prompt as a prop from
`ChatPanel`** (which already computes `effectiveSystemPrompt` at line ~202 and
already owns the paper-full-text system prompt for paper chats) — this is the
fixed prefix `computeBudget` counts. Computes the budget through a small
`hooks/useContextBudget.ts` hook (memoized on messages + systemPrompt +
overrides + last_usage).

### 7.1 Placement

Mounted in `ChatPanel`'s `chat-model-selector` row (the thin bar above the
input showing "Model: [select]"). The ring sits at the right end of that row:

```
┌─────────────────────────────────────────────────────┐
│ Model: [zai-org/glm-5.2 ▾]              ◔ 62%       │  ← ring at row's right end
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ [📎]  [ textarea ............................. ] [Send] │
└─────────────────────────────────────────────────────┘
```

Because `ChatPanel` is shared by `PaperView` and `ChatView`, the ring appears
in both — satisfying "mount on the chat box" with one component.

### 7.2 Ring visual

Small SVG donut (~20px). Fill arc = `pct` of the circumference. Color by
`status`: `ok` = `--accent`, `warn` = amber, `critical` = red. A percentage
label sits beside the donut (`62%`). Theme-aware via existing CSS vars
(consistent with the recent code-box theme work).

### 7.3 Popover (on click)

```
┌──────────────────────────────────────┐
│ Context usage                         │
│ ▰▰▰▰▰▰▰▰▱▱▱▱  62%                    │
│                                       │
│ Used        48.2K   (estimated)       │
│ Total       256K                       │
│ Reserved    32K     (for reply)       │
│ Usable      224K                       │
│ ────────────────────────────────────  │
│ Model capacity   [ Auto ▾ ]           │  Auto/32K/128K/256K/512K/1M/2M
│ Reserved tokens  [ auto ]             │  auto = 12.5%
│ Resolved: glm-5.2 → 128K (detected)   │  (shown only when Auto; source ∈ detected/table/default)
└──────────────────────────────────────┘
```

- "Model capacity" `<select>` writes `context_capacity_override` (0 = Auto).
- "Reserved tokens" input writes `reserve_tokens` (0/blank = auto).
- "Resolved" line shows the resolved capacity + its source when Auto (source is
  `detected` from the provider, `table` from the curated list, or `default`).
- Outside-click closes (same pattern as the existing ⚙ dropdown,
  `ChatToolbar.tsx:63-70`).

## 8. Auto-Truncate Wiring (`ChatPanel.tsx`)

Replace `getContextMessages()` (the message-count slice at lines 206-212) with
a call to `truncateToFit` from the budget module:

```ts
function getContextMessages(): ChatMessage[] {
  const { capacity, reserve } = resolveForConv({ model: modelInfo, capacityOverride: c.context_capacity_override, reserveOverride: c.reserve_tokens });
  const { messages } = truncateToFit(
    c.messages,
    capacity,
    reserve,
    effectiveSystemPrompt,          // includes the paper full text — fixed cost
    c.last_usage?.calibration
  );
  return messages;
}
```

`effectiveSystemPrompt` (already computed in `ChatPanel` at line ~202, = base
system prompt + style-preset modifier) is passed as the fixed, un-droppable
prefix. This is the "info ring + auto-truncate" behavior the user selected:
long chats silently drop the oldest coherent units to stay within
`capacity − reserve`, preventing overflow errors. The ring's `computeBudget`
call passes the same `effectiveSystemPrompt` so its `used` figure matches what
`truncateToFit` actually fits.

The `onContextWindowChange` prop on `ChatToolbar` (and its wiring in
`PaperView.tsx:156`) is **removed** — the ⚙ dropdown no longer has a
context-window row; capacity control lives entirely in the ring's popover.

## 9. Backend

**No changes.** `/api/llm` (`backend/app/routers/llm.py`) forwards `payload`
verbatim, so `stream_options.include_usage` passes through and the upstream
SSE (including the final `usage` chunk) streams back byte-for-byte.
`/api/models` (`backend/app/routers/models.py`) returns `resp.json()` verbatim,
so any `context_length` field PPIO returns is already in the response — only
the frontend normalizer needs to pick it up.

## 10. Mock / Verification Rig (`tools/mock_llm.py`)

Extend the keyless mock so the Playwright rig can exercise both new paths
without a real API key:

1. **`/v1/models` endpoint**: return a small list including an entry with
   `context_length` (e.g. `{id:"zai-org/glm-5.2", context_length: 128000}`) and
   one without — so detection + fallback are both testable.
2. **`usage` in the streamed final chunk**: the turn-2 answer stream emits a
   final `data: {choices:[], usage:{prompt_tokens:1234, completion_tokens:567,
   total_tokens:1801}}` chunk before `[DONE]`, so `parseSSE` captures it and
   calibration fires.

New Playwright script `tools/drive_context_ring.py`: seeds the mock provider,
opens a chat, asserts the ring renders + shows a percentage, opens the popover
(total resolves to 128K for glm-5.2), switches capacity (Auto → 256K) and
confirms it persists to IndexedDB, sends a message and confirms the mock's
`usage` was captured with a calibration factor ≠ 1.0, then sends a ~120K-char
message at 32K capacity and confirms the "truncated" note appears
(auto-truncate dropped oldest messages). The mock's `prompt_tokens` is
proportional to the request (not a fixed value) so calibration stays near 1.0
and truncation is honest. All 7 checks green. Screenshots to `tools/shots/`.

## 11. Files

**New**

- `frontend/src/lib/contextBudget.ts` — pure budget module.
- `frontend/src/hooks/useContextBudget.ts` — memoized budget hook.
- `frontend/src/components/ContextRing.tsx` — ring + popover.
- `frontend/src/lib/__tests__/contextBudget.test.ts` — unit tests for the pure
  module (capacity chain, reserve, estimate, calibration, truncate-to-fit
  incl. tool-group integrity, budget/status thresholds).
- `tools/drive_context_ring.py` — keyless Playwright verification.
- This spec doc.

**Modified**

- `frontend/src/types.ts` — `ModelInfo.context_length`; `Conversation`
  capacity/reserve/usage fields.
- `frontend/src/lib/api.ts` — `streamChat` adds `stream_options.include_usage`;
  `parseSSE` captures `usage`; `fetchModels` picks `context_length`.
- `frontend/src/lib/llm.ts` — `LoopCallbacks.onUsage`; fire on real usage.
- `frontend/src/components/ChatPanel.tsx` — `getContextMessages` →
  `truncateToFit`; mount `<ContextRing/>` in model-selector row; persist
  `last_usage`.
- `frontend/src/components/ChatToolbar.tsx` — remove context-window row + the
  `onContextWindowChange` prop.
- `frontend/src/views/PaperView.tsx` — drop the `onContextWindowChange` prop
  pass-through.
- `frontend/src/store/conversations.ts` — widen `updateSettings` patch.
- `frontend/src/index.css` — ring + popover styles, theme-aware via CSS vars.
- `tools/mock_llm.py` — `/v1/models` + `usage` chunk (§10).

**Unchanged**: `backend/**` (passthrough proxy).

## 12. Rollout (worktree, per user instruction)

1. Create an isolated git worktree (junction-share `frontend/node_modules` with
   the main repo per the project memory — fast dev/build, no slow `npm install`).
2. Implement §4–§10.
3. Verify keyless: backend on :8000, frontend on :5173, mock on :5050; run
   `tools/drive_context_ring.py` (and the existing `drive.py chat`/`paper` for
   regressions). Inspect screenshots + the printed summary line.
4. Run the budget unit tests.
5. Merge into `main` (or wait if another agent's merge is in flight), push.
6. Delete the worktree with the junction-safe procedure from project memory
   (`rmdir` the node_modules junction **first**, verify the main repo's
   `node_modules/.bin/vite` survives, then `rm -rf` the rest + `git worktree
   prune`; kill any orphaned vite by its listen port if removal is blocked).

## 13. Open Questions Resolved

- **Where does the ring mount?** On the chat box (`ChatPanel` model-selector
  row) — appears in both paper and general chat.
- **What happens to history limiting?** Info ring + auto-truncate (the old
  message-count knob is removed).
- **How is "used" measured?** Provider `usage` (ground truth) calibrates a
  light client-side estimate (live signal); estimate alone before first real
  usage.
- **Auto-detect reliability?** Best-effort chain (override → detected → table →
  default); presets (incl. 256K / 1M) are the always-available fallback, so the
  feature works even if PPIO never exposes `context_length`.

## 14. Risks & Mitigations

- **Estimate drift.** The heuristic is approximate (notably for code/mixed
  content). Mitigation: provider `usage` calibrates it after each turn; the
  popover labels the figure "(estimated)" so users don't over-trust it.
- **Tool-group truncation edge cases.** Mitigation: dedicated unit tests for
  orphaned-tool-result scenarios; `truncateToFit` always keeps the latest user
  message and drops whole tool units.
- **Provider doesn't emit `usage`.** Mitigation: `usage` is optional
  throughout; the ring falls back to the uncalibrated estimate. No error path.
- **`context_length` not returned by `/v1/models`.** Mitigation: the curated
  table + presets cover this; `resolveCapacity` always returns a value.
- **Stale cached `ModelInfo` lacking `context_length`.** Old localStorage
  caches predate the field. Mitigation: `resolveCapacity` treats `undefined`
  as "not detected" and falls through to the table — no migration needed.

## 15. Implementation Notes (post-verification)

Refinements made during keyless verification (captured so the doc matches what
shipped):

- **Ring reflects the *truncated* request, not the raw history.** `computeBudget`
  runs `truncateToFit` internally; `used` is the estimate of `systemPrompt` +
  the surviving (truncated) messages, so the ring never shows >100% of usable.
  `Budget.dropped` reports how many messages were trimmed, and the popover shows
  a "N oldest messages truncated on send" note when `dropped > 0`.
- **Per-conversation IDB write serialization (`withConvLock`).** The chat loop
  fires `appendMessages` (assistant/tool messages) and `updateSettings`
  (`last_usage`) concurrently and fire-and-forget. Without serialization each
  mutation read-modify-persisted from a stale in-memory snapshot and the last
  IDB write won — silently dropping `last_usage` (lost to the round-2 answer's
  `appendMessages`). `store/conversations.ts` now wraps every read-modify-persist
  mutator in a per-conversation async mutex so each sees the previous `set`.
  This also hardens the pre-existing append race.
- **Mock `prompt_tokens` is proportional to the request** (~1.1× the client
  heuristic), not a fixed value, so the ring's calibration stays near 1.0 and
  truncation behaves honestly under the keyless rig. A real provider's usage
  has this property naturally.
