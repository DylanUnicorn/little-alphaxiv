# Vision-Model Auto-Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user sends an image to a non-vision model, automatically route that turn (and persistently the rest of the conversation) to a vision-capable model the user has configured on the same provider — same base_url + api_key, just a different model id — with no wasted failed call and no raw error.

**Architecture:** A pure `visionFallback.ts` module (table + two functions) decides capability and the swap. `ChatPanel.send()` calls it before each turn; on a swap it persists via the existing `Conversation.model` override and passes the effective model through to context-budget resolution and `runConversation`. A new optional `Provider.vision_model` field, set in Settings, supplies the fallback target. No backend, no new persistence layer.

**Tech Stack:** TypeScript, React, Zustand (persist), Vitest. Frontend only. All paths relative to `frontend/` unless noted.

## Global Constraints

- **Work in the worktree** `E:\Hust\little_alphaxiv\.claude\worktrees\vision-fallback` (branch `worktree-vision-fallback`). `frontend/node_modules` is a junction to the main repo's — do NOT delete it or run `npm install`.
- **Typecheck is the gate** (`npm run typecheck` = `tsc --noEmit`). There is no lint script. Tests run via `npx vitest run`.
- **No backend changes.** The `/api/llm` proxy is untouched.
- **No new conversation-level field.** The swap persists via the existing `Conversation.model` (`store/conversations.ts updateSettings({ model })`).
- **`vision_model` is optional** on `Provider`; old localStorage loads fine without it. No migration.
- **Mock-LLM E2E contract** (`tools/mock_llm.py`) routes by message content, not model id — do not change the mock. The title-sniffing phrases ("title generator", "paper being discussed") must stay intact elsewhere.
- Follow existing code style: 2-space indent, double quotes, the comment density of the surrounding file. Match `contextBudget.ts` / `contextBudget.test.ts` for the new pure module + tests.

---

## File Structure

- **Create** `frontend/src/lib/visionFallback.ts` — pure module: `VISION_CAPABLE` table, `isVisionCapable()`, `resolveVisionFallback()`. No React/store/IO. Mirrors `lib/contextBudget.ts` discipline.
- **Create** `frontend/src/lib/visionFallback.test.ts` — Vitest unit tests, mirrors `contextBudget.test.ts`.
- **Modify** `frontend/src/types.ts` — add optional `vision_model?: string` to `Provider`.
- **Modify** `frontend/src/components/ChatPanel.tsx` — compute fallback in `send()`; thread `effectiveModel` through `getContextMessages()` + `runConversation()` + `maybeSummarizeTitle()`; add image-error hint in the `catch` block.
- **Modify** `frontend/src/views/SettingsView.tsx` — add a Vision-model selector on each provider row + a hint line.

Each file has one clear responsibility. The pure module is independently testable; the wiring tasks build on it.

---

## Task 1: Pure vision-capability + fallback module (TDD)

**Files:**
- Create: `frontend/src/lib/visionFallback.ts`
- Test: `frontend/src/lib/visionFallback.test.ts`

**Interfaces:**
- Produces (consumed by Task 3):
  - `export const VISION_CAPABLE: { match: string }[]`
  - `export function isVisionCapable(modelId: string | undefined | null): boolean`
  - `export interface VisionFallbackResult { shouldSwap: boolean; model: string }`
  - `export function resolveVisionFallback(args: { hasImage: boolean; currentModel: string; visionModel?: string }): VisionFallbackResult`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/visionFallback.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isVisionCapable,
  resolveVisionFallback,
  VISION_CAPABLE,
} from "./visionFallback";

describe("isVisionCapable", () => {
  it("matches known vision-capable model ids", () => {
    expect(isVisionCapable("gpt-4o")).toBe(true);
    expect(isVisionCapable("gpt-4o-mini")).toBe(true);
    expect(isVisionCapable("gpt-4.1")).toBe(true);
    expect(isVisionCapable("gpt-4.1-mini")).toBe(true);
    expect(isVisionCapable("gpt-4-turbo")).toBe(true);
    expect(isVisionCapable("gemini-2.0-flash")).toBe(true);
    expect(isVisionCapable("claude-3-5-sonnet")).toBe(true);
    expect(isVisionCapable("claude-sonnet-4-6")).toBe(true);
    expect(isVisionCapable("glm-4v")).toBe(true);
    expect(isVisionCapable("qwen2-vl-7b")).toBe(true);
    expect(isVisionCapable("llava-1.5-7b")).toBe(true);
  });

  it("returns false for text-only model ids", () => {
    expect(isVisionCapable("gpt-3.5-turbo")).toBe(false);
    expect(isVisionCapable("glm-5.2")).toBe(false);
    expect(isVisionCapable("deepseek-chat")).toBe(false);
    expect(isVisionCapable("qwen-7b")).toBe(false);
    expect(isVisionCapable("mistral-7b")).toBe(false);
  });

  it("returns false for empty / undefined / null (treats unknown as non-vision)", () => {
    expect(isVisionCapable("")).toBe(false);
    expect(isVisionCapable(undefined)).toBe(false);
    expect(isVisionCapable(null)).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isVisionCapable("GPT-4O")).toBe(true);
    expect(isVisionCapable("Gemini-2.0")).toBe(true);
  });

  it("table lists more-specific patterns before shorter ones", () => {
    // gpt-4.1 must be present and matchable; a bare "gpt-4" (which would also
    // match the non-vision gpt-4 base) is intentionally NOT in the table so
    // only the vision-capable gpt-4.x variants match.
    const matches = VISION_CAPABLE.map((e) => e.match);
    expect(matches).toContain("gpt-4.1");
    expect(matches).not.toContain("gpt-4");
  });
});

describe("resolveVisionFallback", () => {
  it("swaps when image present, current is non-vision, visionModel set and different", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-3.5-turbo",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: true, model: "gpt-4o" });
  });

  it("does NOT swap when current model is already vision-capable", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-4o",
      visionModel: "gpt-4o-mini",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-4o" });
  });

  it("does NOT swap when no visionModel is configured", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-3.5-turbo",
      visionModel: undefined,
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-3.5-turbo" });
  });

  it("does NOT swap when visionModel is empty string", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-3.5-turbo",
      visionModel: "",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-3.5-turbo" });
  });

  it("does NOT swap when no image is present", () => {
    const r = resolveVisionFallback({
      hasImage: false,
      currentModel: "gpt-3.5-turbo",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-3.5-turbo" });
  });

  it("does NOT swap when current === visionModel (idempotent)", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-4o",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-4o" });
  });

  it("swaps when current is an unknown model (unknown = non-vision)", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "some-obscure-text-model",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: true, model: "gpt-4o" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/visionFallback.test.ts`
Expected: FAIL — `Failed to resolve import "./visionFallback"` (module not created yet).

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/lib/visionFallback.ts`:

```ts
// Vision-capability detection + the auto-fallback decision for image input.
//
// Pure functions only: no React, no IO, no store imports. Fully unit-testable
// (see visionFallback.test.ts), same discipline as lib/contextBudget.ts.
//
// Consumer: components/ChatPanel.tsx calls resolveVisionFallback() before each
// turn. When the about-to-be-sent context carries an image and the current
// model is not vision-capable, it routes to the provider's configured
// vision_model (same base_url + api_key, just a different model id).

/** Curated name patterns for models that accept image input. First substring
 *  match (case-insensitive, array order) wins — list more-specific prefixes
 *  before shorter ones. Low-maintenance, mirrors the KNOWN_MODEL_CONTEXT
 *  approach in lib/contextBudget.ts. Unknown ids are treated as NON-vision
 *  (eligible for the auto-swap), which only routes to the user's explicitly
 *  configured vision model — the intended behavior. */
export const VISION_CAPABLE: { match: string }[] = [
  { match: "gpt-4o" },
  { match: "gpt-4.1" },
  { match: "gpt-4-turbo" },
  { match: "gpt-4-vision" },
  { match: "gpt-4.5" },
  { match: "gpt-5" },
  { match: "gemini" }, // all Gemini variants are multimodal
  { match: "claude-3" },
  { match: "claude-sonnet" },
  { match: "claude-opus" },
  { match: "claude-haiku" },
  { match: "glm-4v" },
  { match: "qwen-vl" },
  { match: "qwen2-vl" },
  { match: "qwen2.5-vl" },
  { match: "llava" },
  { match: "internvl" },
  { match: "minicpm-v" },
  { match: "pixtral" },
];

/** True if the model id matches a known vision-capable name pattern.
 *  Empty/undefined/null and unknown ids return false. */
export function isVisionCapable(
  modelId: string | undefined | null
): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  for (const e of VISION_CAPABLE) {
    if (id.includes(e.match.toLowerCase())) return true;
  }
  return false;
}

export interface VisionFallbackResult {
  shouldSwap: boolean;
  /** The model id to actually use this turn (= currentModel when not swapping). */
  model: string;
}

/** Decide whether to route this turn to the provider's vision model.
 *  Swap iff: an image is present, a non-empty vision_model is configured, the
 *  current model differs from it, AND the current model is not already
 *  vision-capable. Idempotent: once swapped (current === visionModel) it stops
 *  swapping. */
export function resolveVisionFallback(args: {
  hasImage: boolean;
  currentModel: string;
  visionModel?: string;
}): VisionFallbackResult {
  const { hasImage, currentModel, visionModel } = args;
  const shouldSwap =
    hasImage &&
    !!visionModel &&
    visionModel.length > 0 &&
    currentModel !== visionModel &&
    !isVisionCapable(currentModel);
  return { shouldSwap, model: shouldSwap ? visionModel! : currentModel };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/visionFallback.test.ts`
Expected: PASS — all `isVisionCapable` + `resolveVisionFallback` tests green.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors (module is self-contained, no imports of it yet).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/visionFallback.ts frontend/src/lib/visionFallback.test.ts
git commit -m "feat(vision): add vision-capability table + fallback decision module"
```

---

## Task 2: Add `vision_model` field to `Provider` type

**Files:**
- Modify: `frontend/src/types.ts:4-11` (the `Provider` interface)

**Interfaces:**
- Produces: `Provider.vision_model?: string` — consumed by Task 3 (`ChatPanel.send` reads `provider.vision_model`) and Task 4 (Settings UI writes it via `updateProvider`).
- Consumes: nothing new. `store/settings.ts updateProvider` already spreads arbitrary `Partial<Provider>` patches, so the field flows through unchanged once the type declares it.

- [ ] **Step 1: Add the optional field to `Provider`**

In `frontend/src/types.ts`, change the `Provider` interface from:

```ts
/** A configured LLM provider (OpenAI-compatible). Stored in localStorage. */
export interface Provider {
  id: string;
  name: string;
  base_url: string; // e.g. https://api.openai.com/v1
  api_key: string;
  model: string; // e.g. gpt-4o-mini
  is_default?: boolean;
}
```

to:

```ts
/** A configured LLM provider (OpenAI-compatible). Stored in localStorage. */
export interface Provider {
  id: string;
  name: string;
  base_url: string; // e.g. https://api.openai.com/v1
  api_key: string;
  model: string; // e.g. gpt-4o-mini
  is_default?: boolean;
  /** Optional vision-capable model id on the SAME provider (same base_url +
   *  api_key). When set, the chat panel auto-routes any turn whose context
   *  includes an image to this model if the current model isn't vision-capable.
   *  Undefined = no vision fallback configured for this provider. */
  vision_model?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors (adding an optional field is backward-compatible; the `EMPTY` constant in `SettingsView` and `addProvider` callers stay valid).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts
git commit -m "feat(vision): add optional Provider.vision_model field"
```

---

## Task 3: Wire the fallback into `ChatPanel.send()`

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx` — import the helper; compute the fallback in `send()`; thread `effectiveModel` through `getContextMessages()`, `runConversation()`, and `maybeSummarizeTitle()`; add an image-error hint in the `catch` block.

**Interfaces:**
- Consumes: `resolveVisionFallback` from Task 1; `Provider.vision_model` from Task 2.
- Produces: the user-visible behavior (auto-swap + friendly error). No new exports.

**Context to know:** `ChatPanel.send()` currently (a) builds `userMsg`, (b) calls `getContextMessages()` which reads the outer-scope `currentModel = c.model || provider?.model`, (c) calls `runConversation({ model: c.model, ... })`, (d) on the first turn calls `maybeSummarizeTitle({ model: c.model, ... })`. The `catch (e)` block appends an error message. The goal: compute an `effectiveModel` that may differ from `c.model` when a swap is needed, and use it everywhere `c.model` was used for the *outgoing request*. The swap persists via the existing `_updateSettings(c.id, { model })`.

- [ ] **Step 1: Add the import**

At the top of `frontend/src/components/ChatPanel.tsx`, after the existing `lib/llm` import line:

```ts
import { runConversation, generateConversationTitle } from "../lib/llm";
```

add:

```ts
import { resolveVisionFallback } from "../lib/visionFallback";
```

- [ ] **Step 2: Make `getContextMessages()` take the effective model**

`getContextMessages()` currently closes over the outer-scope `currentModel` (line ~194) and `cachedModels`. Change its signature to accept the model id explicitly so the fallback's model drives capacity resolution. Replace the whole function (currently at roughly `ChatPanel.tsx:211-226`) with:

```ts
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
```

- [ ] **Step 3: Compute the fallback + thread `effectiveModel` through `send()`**

In `send()`, locate the block that currently begins:

```ts
    let buf = "";
    try {
      const contextMsgs = getContextMessages();
      const history: ChatMessage[] = [...contextMsgs, userMsg];
      const { newMessages } = await runConversation({
        provider,
        messages: history,
        systemPrompt: effectiveSystemPrompt,
        model: c.model,
        callbacks: {
```

Replace with the version below. **Note the scoping:** `hasImage` is declared *before* `try` because the `catch` block (Step 5) must also read it — a `catch` block cannot see `const`/`let` declared inside `try`. `baseModel`, `effectiveModel`, and the swap only live inside `try`.

```ts
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

    let buf = "";
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
        callbacks: {
```

- [ ] **Step 4: Pass `effectiveModel` to `maybeSummarizeTitle`**

In the same `send()`, after the `runConversation` call resolves, the first-turn title block currently reads:

```ts
      if (wasFirstTurn) {
        void maybeSummarizeTitle({
          convId: c.id,
          type: c.type,
          paperId: c.paper_id,
          model: c.model,
          provider,
          firstUserText: text,
          newMessages,
          rename,
        });
      }
```

Change `model: c.model,` to `model: effectiveModel,`:

```ts
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
```

(`effectiveModel` is in scope — it's declared in the `try` block above. A vision model can produce a short text title; on any failure the truncated-first-message fallback stays per the existing title contract, so no special-casing.)

- [ ] **Step 5: Add the image-error hint in the `catch` block**

The existing `catch (e: any)` block currently produces `errMsg` and appends an error message. Locate:

```ts
    } catch (e: any) {
      const errMsg = e?.message || "error";
      setStreaming("");
      setReasoning("");
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
      setStatus("");
    } finally {
```

Insert a derived `displayMsg` that replaces the bare `errMsg` in BOTH append branches when the error looks image-related and no vision model is configured (a configured vision model would have proactively swapped and prevented this; this branch only covers the "no vision model" case). Replace the block with:

```ts
    } catch (e: any) {
      const rawMsg = e?.message || "error";
      setStreaming("");
      setReasoning("");
      // When an image was sent to a non-vision model and the user hasn't
      // configured a vision_model, the provider rejects it with an
      // image/vision/multimodal error. Surface a actionable hint instead of
      // the raw upstream body. (When a vision_model IS configured, the
      // proactive swap above should have prevented this error entirely.)
      const looksLikeImageError = /image|vision|multimodal|does not support/i.test(rawMsg);
      const displayMsg =
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
          { role: "assistant", content: buf, ui: { error: `Response interrupted: ${displayMsg}` } },
        ]);
      } else {
        await appendMessages(c.id, [
          { role: "assistant", content: `⚠️ ${displayMsg}`, ui: { error: String(displayMsg) } },
        ]);
      }
      setStatus("");
    } finally {
```

(`hasImage` and `provider` are in scope — `hasImage` was declared before the `try` block in Step 3 precisely so this `catch` can read it, and `provider` is the component-level value.)

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors. Watch for: `effectiveModel`/`hasImage` used-before-declaration (both are declared before use in the `try` block), and the `getContextMessages` call-site now passing an argument.

- [ ] **Step 7: Run the existing test suite to confirm no regression**

Run: `cd frontend && npx vitest run`
Expected: all existing tests pass (ChatPanel itself isn't unit-tested, but `contextBudget` tests must stay green — `getContextMessages` only changed how its caller passes the model, not `truncateToFit`).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/ChatPanel.tsx
git commit -m "feat(vision): auto-route image turns to provider vision model"
```

---

## Task 4: Settings UI — vision-model selector per provider

**Files:**
- Modify: `frontend/src/views/SettingsView.tsx` — add a Vision-model selector inside each provider row + a hint line under the Providers section.

**Interfaces:**
- Consumes: `Provider.vision_model` (Task 2), the per-provider `cached` models list (already in the render loop), and `useSettings.getState().updateProvider`.
- Produces: user-facing control to set `vision_model`.

- [ ] **Step 1: Add a Vision-model row inside the provider item**

In `frontend/src/views/SettingsView.tsx`, inside the `providers.map((p) => { ... })` block, the existing `.provider-models-row` div ends at roughly line 136. After that closing `</div>` (still inside `.provider-item`), add a new vision-model row. Locate:

```tsx
                  {hasModels && (
                    <select
                      className="provider-model-select"
                      value={p.model}
                      onChange={(e) => useSettings.getState().updateProvider(p.id, { model: e.target.value })}
                      title="Switch model"
                    >
                      {cached.map((m) => (
                        <option key={m.id} value={m.id}>{m.id}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
```

Replace with (adds the vision-model row before the final `</div>` of `.provider-item`):

```tsx
                  {hasModels && (
                    <select
                      className="provider-model-select"
                      value={p.model}
                      onChange={(e) => useSettings.getState().updateProvider(p.id, { model: e.target.value })}
                      title="Switch model"
                    >
                      {cached.map((m) => (
                        <option key={m.id} value={m.id}>{m.id}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="provider-vision-row">
                  <span className="provider-vision-label">Vision model</span>
                  {hasModels ? (
                    <select
                      className="provider-model-select"
                      value={p.vision_model ?? ""}
                      onChange={(e) =>
                        useSettings
                          .getState()
                          .updateProvider(p.id, { vision_model: e.target.value || undefined })
                      }
                      title="Model used automatically when you send an image and your main model can't handle vision"
                    >
                      <option value="">(not set)</option>
                      {cached.map((m) => (
                        <option key={m.id} value={m.id}>{m.id}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="provider-model-input"
                      value={p.vision_model ?? ""}
                      onChange={(e) =>
                        useSettings
                          .getState()
                          .updateProvider(p.id, { vision_model: e.target.value || undefined })
                      }
                      placeholder="vision model id (optional)"
                      title="Model used automatically when you send an image and your main model can't handle vision"
                    />
                  )}
                </div>
              </div>
            );
```

- [ ] **Step 2: Add a hint line under the Providers section**

Locate the Providers hint paragraph (roughly `SettingsView.tsx:90-95`):

```tsx
        <h2>Providers</h2>
        <p className="settings-hint">
          Add any OpenAI-compatible endpoint (OpenAI, Anthropic via a compatible
          gateway, local Ollama/OpenAI servers, etc.). Keys are stored only in
          your browser (localStorage) and sent to the backend proxy per request.
        </p>
```

Append a second hint paragraph immediately after it:

```tsx
        <h2>Providers</h2>
        <p className="settings-hint">
          Add any OpenAI-compatible endpoint (OpenAI, Anthropic via a compatible
          gateway, local Ollama/OpenAI servers, etc.). Keys are stored only in
          your browser (localStorage) and sent to the backend proxy per request.
        </p>
        <p className="settings-hint">
          <strong>Vision model:</strong> used automatically when you send an
          image and your main model can't handle vision. Same base URL &amp; key
          — just a different model id on the same provider.
        </p>
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (`p.vision_model` is now a valid optional field; `?? ""` covers the undefined case for the controlled input/select value.)

- [ ] **Step 4: Build to confirm the app compiles end-to-end**

Run: `cd frontend && npm run build`
Expected: success (`tsc --noEmit && vite build`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/SettingsView.tsx
git commit -m "feat(vision): per-provider vision-model selector in Settings"
```

---

## Task 5: Manual E2E verification via the Playwright mock rig

**Files:** none modified — verification only. Uses the existing `tools/mock_llm.py` and a small inline Playwright check (or the existing `tools/drive_*.py` pattern).

**Goal:** prove the swap fires end-to-end: an image turn routes to the configured `vision_model`, the conversation's model is persisted, and a follow-up turn stays on the vision model (idempotent). Also confirm the mock tolerates `image_url` content parts.

- [ ] **Step 1: Confirm the mock tolerates image content parts**

Read `tools/mock_llm.py`'s content-inspection helpers (`_has_tool_result`, `_is_title_request`, `_is_paper_title_request`). They call `m.get("content")` and test `isinstance(c, str)` — when `content` is a multimodal array (object, not str), the `isinstance(c, str)` checks are false, so they skip that message rather than crashing. Verify by inspection; if any helper does `c.lower()` or substring search on a non-str `content` unguarded, note it. (Per spec: the mock should already be safe because the helpers guard with `isinstance(c, str)`.)

- [ ] **Step 2: Start the three servers**

In three terminals (all in the worktree root):
1. Backend: `cd backend && ./run.sh` (uses `Agent_env` conda env)
2. Frontend: `cd frontend && npm run dev`
3. Mock LLM: `python tools/mock_llm.py` (in `Agent_env`)

Wait for each to report it's listening (`:8000`, `:5173`, `:5050`).

- [ ] **Step 3: Configure a provider with a vision_model**

In the app (http://localhost:5173), open Settings → Providers and add a provider:
- base_url = `http://127.0.0.1:5050/v1`
- api_key = `mock`
- model = `mock-model` (non-vision per the table — `isVisionCapable("mock-model")` is false)
- Vision model = `gpt-4o` (vision-capable per the table) — type it in the Vision model field, or set it after fetching models.

Set it as default.

- [ ] **Step 4: Send an image turn and verify the swap**

In a new chat, paste or upload an image, type a short prompt (e.g. "describe this"), send.
- Observe the status line briefly shows "Switched to gpt-4o for image input…".
- The mock streams its canned response (it ignores model id, so the turn completes).
- After the turn, open the model dropdown in the chat panel: it now shows `gpt-4o` (the conversation's persisted `model`).

- [ ] **Step 5: Verify idempotency on a follow-up turn**

Send a second, text-only message.
- No "Switched to…" status (the swap does not re-fire — `currentModel === visionModel`).
- The model dropdown still shows `gpt-4o`.

- [ ] **Step 6: Verify the no-vision-model error hint**

Edit the provider: clear the Vision model field (set to "(not set)"). Start a NEW chat, switch its model dropdown back to `mock-model` (non-vision), attach an image, send.
- Since `mock_llm.py` doesn't actually reject images, this verifies the *hint path* is wired but won't trigger a rejection against the mock. To truly exercise the hint, point the provider at a real text-only endpoint OR temporarily make the mock reject image content. Note this gap in the verification log; the hint regex + branch are unit-covered by inspection in Task 3 Step 5. (Acceptable: the mock is a happy-path rig; the error-hint branch is a defensive fallback for the real-provider case the spec calls out.)

- [ ] **Step 7: Stop the servers and record result**

Stop backend / frontend / mock (`Ctrl-C` each, or `TaskStop`). If verification passed, the feature is done. No commit (verification only).

---

## Self-Review (run after writing — results recorded here)

**1. Spec coverage:**
- Data model `Provider.vision_model` → Task 2 ✓
- `visionFallback.ts` pure module (table + `isVisionCapable` + `resolveVisionFallback`) → Task 1 ✓
- Wiring in `ChatPanel.send` (compute, persist via `_updateSettings`, thread through `getContextMessages`/`runConversation`/`maybeSummarizeTitle`) → Task 3 ✓
- Error-path image hint → Task 3 Step 5 ✓
- Settings UI selector + hint → Task 4 ✓
- Idempotency → covered by Task 1 test + Task 5 Step 5 ✓
- Unit tests (mirroring `contextBudget.test.ts`) → Task 1 ✓
- E2E via Playwright mock rig + mock-tolerates-image note → Task 5 ✓
- Paper-chat limitation (out of scope) — documented in spec, no task needed ✓
- No backend / no new persistence layer — no tasks touch backend or add a conv field ✓

**2. Placeholder scan:** none. Every code step contains full code; every command has expected output.

**3. Type consistency:**
- `resolveVisionFallback` signature matches across Task 1 (definition) and Task 3 (call site): `{ hasImage, currentModel, visionModel }` → `{ shouldSwap, model }` ✓
- `getContextMessages(modelId: string)` — Task 3 Step 2 defines it taking a `string`, Step 3 calls `getContextMessages(effectiveModel)` ✓
- `Provider.vision_model?: string` — Task 2 defines it; Task 3 reads `provider.vision_model`; Task 4 reads `p.vision_model ?? ""` and writes `{ vision_model: ... | undefined }` ✓
- `effectiveModel`/`hasImage` used in `send()`: `hasImage` is declared *before* `try` (Step 3) so the `catch` block (Step 5) can read it; `effectiveModel` lives inside `try` and is not referenced in `catch`. Scope verified ✓
