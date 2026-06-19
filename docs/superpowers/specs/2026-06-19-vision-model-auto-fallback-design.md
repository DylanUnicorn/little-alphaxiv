# Vision-Model Auto-Fallback

**Date:** 2026-06-19
**Scope:** Frontend only. Applies to both general chat (`/chat/:id`) and paper view (`/paper/:arxivId`) because they share one `ChatPanel`.

## Problem

Not every model supports vision. When a user attaches an image (paste or upload) and sends it to a text-only model, the provider rejects the request — typically a `400`/`422` with a body like *"model does not support image input"* — and the user sees a raw error string with no recovery path. The image persists in the conversation history (every `ChatMessage` with `attachments` is replayed on every subsequent turn), so the rejection repeats on **every** follow-up turn in that thread, not just the first.

The app already has the building blocks to do better: a per-conversation model override (`Conversation.model`, falls back to `Provider.model`) and OpenAI multimodal `image_url` content-part assembly in `runConversation` (`frontend/src/lib/llm.ts:89-100`). What's missing is (a) a place to record a vision-capable model per provider, and (b) the logic that swaps to it when an image is present and the current model can't handle vision.

## Goal

When the user sends an image to a model that is not vision-capable, **automatically and proactively** route that turn (and, persistently, the rest of the conversation) to a vision model the user has configured on the same provider — same `base_url` and `api_key`, just a different model id. No wasted failed call, no raw error. The switch is visible in the existing model selector so there's no mismatch between the UI and the model actually serving the request.

## Non-goals

- **No cross-provider fallback.** The vision model must live on the same provider as the main model (same `base_url`/`api_key`). This keeps the feature to "a different model id on the same endpoint" and avoids mixing credentials.
- **No reading vision capability from `/v1/models`.** No OpenAI-compatible standard field reliably reports multimodal support. Capability is decided by a curated name-pattern table (mirroring the existing `KNOWN_MODEL_CONTEXT` approach), with unknown models treated as non-vision.
- **No reactive try-then-retry.** Routing is proactive: if the about-to-be-sent context carries an image and the current model is not known-vision-capable, swap before the first call. (A reactive net was considered and rejected — see "Alternatives considered".)
- **No backend changes.** The `/api/llm` proxy is a dumb pipe and stays untouched.
- **No new persistence layer.** The switch persists via the existing `Conversation.model` override (written through `store/conversations.ts updateSettings`), not a new field.

## Behavior

### When the swap fires

On each `ChatPanel.send()` (`frontend/src/components/ChatPanel.tsx:228`), **before** building the context / calling `runConversation`:

1. `currentModel = c.model || provider.model` (existing precedence).
2. Determine `hasImage`: true if **any** message in `[...c.messages, userMsg]` carries a non-empty `attachments` array with an `image`-type entry. Because images persist in history, once true it stays true until that message is truncated out of context by `truncateToFit` — which is exactly why the switch is persisted for the conversation rather than re-decided per turn.
3. Resolve the fallback: `const { shouldSwap, model: effectiveModel } = resolveVisionFallback({ hasImage, currentModel, visionModel: provider.vision_model })`.
4. **If `shouldSwap`**: persist the switch via `_updateSettings(c.id, { model: effectiveModel })` (fire-and-forget, same pattern as the existing `last_usage` write), and use `effectiveModel` for both the context-budget capacity resolution (`getContextMessages`) and `runConversation({ model: effectiveModel })`. Set a one-shot status note.
5. **If `hasImage && !visionModel && !isVisionCapable(currentModel)`**: no vision model is configured — proceed with the call as-is. In the `catch` block, if the error looks image-related, show a friendly hint ("This model doesn't support images. Add a vision model in Settings → Providers.") instead of the raw upstream body.

### The decision is idempotent

After a successful swap, `c.model === vision_model`, so on the next turn `currentModel === visionModel` and `resolveVisionFallback` returns `shouldSwap: false`. No re-swap, no churn. The model dropdown in the chat panel reflects the new model automatically (it derives from `c.model`).

### Stick-for-conversation (approved)

Once the swap fires, it sticks for the rest of the conversation. Follow-up questions about the image naturally keep using the vision model, and the model selector shows the actual model in use. The user can switch back to any model at any time via the existing model dropdown — if they switch back to a non-vision model and the image is still in context, the swap simply fires again on the next turn.

## Architecture / Components

### 1. Data model — `frontend/src/types.ts`

Add an optional field to `Provider`:

```ts
export interface Provider {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  is_default?: boolean;
  /** Optional vision-capable model id on the SAME provider (same base_url +
   *  api_key). When set, the chat panel auto-routes any turn whose context
   *  includes an image to this model if the current model isn't vision-capable.
   *  Undefined = no vision fallback configured for this provider. */
  vision_model?: string;
}
```

Optional, persisted via the existing `zustand persist` settings store. **No migration**: older localStorage blobs load fine with `vision_model` absent.

### 2. Vision-capability table + pure helper — `frontend/src/lib/visionFallback.ts` (new)

Pure module, no React/store/IO imports — fully unit-testable, same discipline as `contextBudget.ts`.

```ts
/** Curated name patterns for models that accept image input. First substring
 *  match (case-insensitive, array order) wins — list more-specific prefixes
 *  before shorter ones (e.g. "gpt-4.1" before "gpt-4"). Low-maintenance,
 *  mirrors the KNOWN_MODEL_CONTEXT approach. Unknown ids are non-vision. */
export const VISION_CAPABLE: { match: string }[] = [
  { match: "gpt-4o" },
  { match: "gpt-4.1" },
  { match: "gpt-4-turbo" },
  { match: "gpt-4-vision" },
  { match: "gpt-4.5" },
  { match: "gpt-5" },
  { match: "gemini" },        // all Gemini variants are multimodal
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

export function isVisionCapable(modelId: string | undefined | null): boolean {
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
 *  Swap iff: an image is present, a vision_model is configured, the current
 *  model differs from it, AND the current model is not already vision-capable. */
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

### 3. Wiring — `frontend/src/components/ChatPanel.tsx`

In `send()`, after `userMsg` is built and before `getContextMessages()`:

```ts
const currentModel = c.model || provider.model || "";
const hasImage = [...c.messages, userMsg].some(
  (m) => m.role === "user" && m.attachments && m.attachments.some((a) => a.type === "image")
);
const { shouldSwap, model: effectiveModel } = resolveVisionFallback({
  hasImage,
  currentModel,
  visionModel: provider.vision_model,
});
if (shouldSwap) {
  void _updateSettings(c.id, { model: effectiveModel }); // persist the switch
  setStatus(`Switched to ${effectiveModel} for image input…`);
}
```

Then pass `effectiveModel` everywhere `c.model` was previously passed in `send`:
- `getContextMessages()` — resolve capacity against the vision model's context length (look it up in `cachedModels` by `effectiveModel`), so the context ring and `truncateToFit` use the right window.
- `runConversation({ model: effectiveModel, ... })`.
- The `maybeSummarizeTitle` call's `model` arg — pass `effectiveModel` (a vision model can still generate a text title; if it's slow/fails the truncated fallback stays, per existing title-generation contract).

`getContextMessages` currently reads `currentModel` from the outer scope (`c.model || provider.model`). It must instead accept the effective model (or be inlined to use `effectiveModel`) so the capacity lookup matches the model actually being called.

**Error-path hint**: in the existing `catch (e)` block, add a check — when `!shouldSwap` (i.e. no swap happened) and the error string matches an image/vision/multimodal pattern, surface a hint pointing to Settings instead of the raw message:

```ts
const looksLikeImageError = /image|vision|multimodal|does not support/i.test(errMsg);
if (hasImage && !provider.vision_model && looksLikeImageError) {
  // surface: "This model doesn't support images. Add a vision model in Settings → Providers."
}
```

(When `vision_model` IS configured, a proactive swap should have prevented the error; this branch only covers the "no vision model configured" case.)

### 4. Settings UI — `frontend/src/views/SettingsView.tsx`

On each provider row (next to the existing model `<select>`), add a **Vision model** selector using the same cached-models dropdown + free-text fallback pattern already used for the main model. Includes an explicit "unset" option (empty value). Writes via `useSettings.getState().updateProvider(p.id, { vision_model: value || undefined })`.

A hint line under the section: *"Used automatically when you send an image and your main model can't handle vision. Same base URL & key — just a different model id."*

### 5. No changes elsewhere

- `store/settings.ts`: `updateProvider` already spreads arbitrary patches and `Provider` is a plain interface, so `vision_model` flows through unchanged. No store change.
- `store/conversations.ts`: `updateSettings({ model })` already exists and persists `Conversation.model`. Reused as-is.
- `lib/llm.ts` / `lib/api.ts`: the `model` override path (`modelOverride || provider.model`) already honors a passed model. Reused as-is.
- `lib/contextBudget.ts`: no change; capacity resolution already takes a `{ id, context_length }` model object.
- Backend: untouched.

## Edge cases

- **No vision model configured + non-vision current model + image**: proceed → on image error, show the friendly "add a vision model" hint. No silent failure, no crash.
- **Vision-capable current model + image**: `isVisionCapable(currentModel)` true → `shouldSwap` false → no swap, even if a `vision_model` is configured. The user's chosen vision-capable model is used directly.
- **`vision_model` configured and equal to current model**: `currentModel !== visionModel` false → no swap. Idempotent.
- **Image scrolled out of context**: if `truncateToFit` drops the image-bearing message, `hasImage` becomes false on later turns and the swap no longer fires — but the persisted `Conversation.model` stays as the vision model (the user already chose it for this thread). The user can switch back via the dropdown. This is acceptable and matches "stick for the conversation."
- **Paper chats**: their system prompt carries the full PDF text and can be very large. Switching to a vision model with a smaller context window could, in principle, overflow. **Known limitation, out of scope for v1** — `truncateToFit` handles windows generically by dropping oldest history; the user should pick a high-context vision model or avoid images in paper chats.
- **Title generation**: text-only, non-streaming. After a swap it uses the vision model. A vision model can produce a short text title; on any failure the truncated-first-message fallback stays (existing contract). No special-casing.
- **Unknown model id**: `isVisionCapable` returns false → eligible for swap. The only effect is routing to the user's *explicitly-configured* vision model, which is the intended behavior.

## Testing

### Unit tests — `frontend/src/lib/visionFallback.test.ts` (new, mirrors `contextBudget.test.ts`)

- `isVisionCapable`: gpt-4o / gpt-4.1 / gemini-2.0-flash / claude-3-5-sonnet / glm-4v / qwen2-vl / llava-1.5 → true; gpt-3.5 / glm-5 / deepseek-chat / qwen-7b / mistral → false; empty/undefined/null → false; case-insensitive ("GPT-4O") → true.
- `resolveVisionFallback`:
  - image + non-vision current + visionModel set, current≠visionModel → swap, model = visionModel.
  - image + vision-capable current (gpt-4o) + visionModel set → no swap.
  - image + no visionModel → no swap.
  - no image + visionModel set → no swap.
  - image + current === visionModel → no swap (idempotent).
  - image + visionModel set + unknown current model → swap (unknown = non-vision).
- `VISION_CAPABLE` table ordering: ensure a more-specific entry matches before a shorter one (e.g. assert "gpt-4.1" matches, not accidentally shadowed).

### Manual / E2E verification (Playwright rig)

- Configure a provider whose main `model` is a non-vision id and whose `vision_model` is a vision-capable id (against `tools/mock_llm.py`, which doesn't care about model id).
- Upload/paste an image and send a text prompt.
- Assert: the request body the mock receives carries the **vision_model** id (not the main model), and the chat panel's model dropdown updates to the vision model after the turn.
- Assert: a follow-up text-only turn keeps using the vision model (idempotent, no second swap / no churn).

**Mock-LLM note:** `tools/mock_llm.py` routes by message content (title-sniffing, tool-result presence), not by model id, so a vision-model-id request flows through the same canned responses. No mock change needed. If a future E2E script attaches an image, the mock must tolerate `image_url` content parts in the `messages` it inspects — flag for the implementer to verify the `_has_tool_result`/`_is_title_request` content checks don't choke on array-typed `content`.

## Alternatives considered

- **Reactive (try-then-retry):** send to the current model first, retry on a 4xx image error. Rejected: because images persist in history, *every* turn in an image conversation would pay one failed call before succeeding — noticeable latency per turn — and matching "is this error an image error" across providers is heuristic and fragile. Proactive routing avoids both.
- **Per-turn swap (not sticky):** don't persist `Conversation.model`; decide per turn. Rejected: the model selector would show the user's original model while image turns silently use a different one — a UI/reality mismatch. Stick-for-conversation keeps the selector honest and is simpler to reason about.
- **Cross-provider vision fallback:** allow the vision model to live on a different provider. Rejected for v1: mixes credentials/base URLs, complicates the "same endpoint, different model id" framing the user asked for, and the per-provider setting is sufficient.
- **A separate `Conversation.used_vision_fallback` flag:** rejected — redundant. Persisting via the existing `Conversation.model` field already records the switch and feeds the dropdown; an extra flag would just duplicate state.
