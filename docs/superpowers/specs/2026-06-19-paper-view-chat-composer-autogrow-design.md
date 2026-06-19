# Unified Chat Composer with Auto-Growing Input

**Date:** 2026-06-19
**Scope:** Frontend only. Applies to both general chat (`/chat/:id`) and paper view (`/paper/:arxivId`) because they share one `ChatPanel`.

## Problem

The shared `ChatPanel` input is a **fixed** `rows={1}` textarea — `resize: none`, `min-height: 40px`, `max-height: 160px` — with no auto-grow JS (`frontend/src/components/ChatPanel.tsx:450-458`, `frontend/src/index.css:398-402`). Long input scrolls inside a one-line box, so the user cannot see what they typed. The model selector and context-usage ring sit in a separate row above the input (`ChatPanel.tsx:396-431`); the send/attach buttons are inconsistent — a latent CSS specificity bug makes `.attach-btn` mostly overridden by `.chat-input-row button` (`index.css:403-407` outranks `775-780`). Paper view additionally carries a **redundant second model selector** inside the `ChatToolbar` ⚙ dropdown (`ChatToolbar.tsx:102-125`).

## Goal

Replace the fixed input with a **unified rounded container** (ChatGPT / Claude.ai style): a top **auto-growing textarea** (starts at 2 lines, grows with content, caps then scrolls) and a **fixed bottom bar** holding `[attach] [model pill] … [context ring] [send]`. No divider between input area and bar. Apply to both views via the shared `ChatPanel`.

## Non-goals

- No backend / data-flow / storage changes.
- No `ContextRing` math or token-budget changes.
- No title-generation changes (the `tools/mock_llm.py` title-sniffing contract is untouched).
- No changes to the two-pane PDF layout or divider drag behavior (divider already resizes the chat column width; the new textarea just re-measures on width change).

## Behavior

### Auto-grow
- **Initial height = 2 lines** (~60–64px). Empty input still shows 2 lines of space.
- **On input change:** set the textarea height to `auto`, then to `scrollHeight` (clamped to the cap). Smooth, no animation jank.
- **Cap = `min(40vh, 240px)`** (~8 lines). On reaching the cap: `overflow-y: auto` → the browser's native scrollbar appears; **mouse wheel and ↑/↓ arrow keys browse the input via native textarea behavior**. No custom scroll code.
- **Shrinking content** auto-shrinks the box back toward the 2-line initial height.
- **Width changes** (paper-view divider drag reflows the column): a `ResizeObserver` on the textarea re-measures `scrollHeight` so the height stays correct after line wrapping changes.

### Container layout

```
.chat-composer                ← big rounded container (border + bg + padding); NO internal divider
  .chat-composer-input        ← top, grows upward as content increases
    <textarea>                ← min 2 lines, auto-grow, scroll after cap
  [.attachment-previews]      ← shown only when attachments exist (inside container, above the bar)
  .chat-composer-bar          ← bottom row, fixed; NO top border
    .left:   ⊕(attach)   [glm-5.2 ▾](model pill)
    .right:  ◉(ContextRing)   ➤(send)
```

- The container sits at the very bottom of `ChatPanel`, below `.chat-status`. When the textarea grows, it eats the messages area above it (messages area is `flex:1`, so it yields).
- **No separator** between the input area and the bottom bar (per user request).

### Bottom-bar controls (left → right)

1. **Attach** (`.left`): a **circular icon button** (a circle wrapping a logo, e.g. ⊕ / 📎). Reuses the existing hidden `<input type=file>` + `handleFileSelect` + `handlePaste` image-paste flow.
2. **Model pill** (`.left`, right of attach): a **custom dropdown capsule** showing `currentModel ▾`; click opens the model list; the current model is marked ✓; click-outside and Escape close; keyboard ↑/↓/Enter/Esc supported. Reuses the existing `availableModels` / `currentModel` / `handleModelChange`. This replaces the old `.chat-model-selector` row's native `<select>`.
3. **ContextRing** (`.right`): the existing `ContextRing` component, **reused as-is** — `<ContextRing conversationId={c.id} systemPrompt={effectiveSystemPrompt} />`.
4. **Send** (`.right`, right of the ring): a **small icon button** (paper-plane / ↑), accent-colored, disabled when input is empty (no attachments) or when `busy`.

### Decisions / defaults (user-approved 2026-06-19)

- Cap `min(40vh, 240px)`; initial height 2 lines.
- Delete the redundant model selector in `ChatToolbar` ⚙ dropdown (Style + Theme sections remain).
- `.chat-status` stays above the container, unchanged (minimal blast radius).
- Attachment previews move **inside** the container (above the bar), no longer hovering outside it.

## Architecture / Components

Two new components; `ChatPanel` becomes a thin orchestrator that passes state and callbacks in as props. (Chosen over an inlined rewrite so `ChatPanel` — already large — does not grow further, and so each piece is testable in isolation.)

### `ChatComposer.tsx` (new)

A controlled component rendering the unified container. Owns the auto-grow `useLayoutEffect` + `ResizeObserver` on a textarea ref.

Props (all passed down from `ChatPanel`):
- `value`, `onChange`, `onSend`, `onKeyDown`, `onPaste`, `busy`, `placeholder`
- `attachments` + `onRemoveAttachment` (renders `.attachment-previews` inside the container)
- `availableModels`, `currentModel`, `onModelChange` (forwarded to `ModelSelectPill`)
- `conversationId`, `effectiveSystemPrompt` (forwarded to `ContextRing`)
- `onAttach` (opens the hidden file input)

Renders: `.chat-composer` > (`.chat-composer-input` > `<textarea>`) + (`attachments.length ? .attachment-previews`) + (`.chat-composer-bar` > `.left`(attach, ModelSelectPill) + `.right`(ContextRing, send)).

### `ModelSelectPill.tsx` (new)

A custom dropdown capsule.

Props: `models: { id: string }[]`, `value: string`, `onChange: (id: string) => void`, `disabled?: boolean`.

Behavior: button shows `value ▾`; click toggles a popover listing `models`; current `value` row is checked ✓; outside-click and Escape close; ↑/↓ moves selection, Enter confirms, Escape cancels. Single-level — no focus trap required. Empty model list falls back to a text `<input>` (parity with the current behavior for providers with no cached model list).

### `ChatPanel.tsx` (modified)

- **Remove** the `.chat-model-selector` row (`ChatPanel.tsx:396-431`).
- **Remove** the `.chat-input-row` block (`ChatPanel.tsx:433-462`) and its attachment-previews block (`:464-478`).
- **Render** `<ChatComposer ...props />` at the bottom, below `.chat-status`.
- **Keep** the `effectiveSystemPrompt` build (`ChatPanel.tsx:204-205`) — it is forwarded through the composer into `ContextRing`.
- The hidden `<input type=file>` and its `handleFileSelect`/`handlePaste` handlers stay (the composer calls `onAttach`).

### `ChatToolbar.tsx` (modified)

- **Remove** the Model section (`ChatToolbar.tsx:102-125`) from the ⚙ dropdown. Keep the Style and Theme sections. (The toolbar's own `fetchModels` call and `onModelChange` prop become unused and are removed.)

### `index.css` (modified)

- **Add:** `.chat-composer`, `.chat-composer-input`, `.chat-composer-bar`, `.composer-attach-btn`, `.composer-send-btn`, `.model-pill`, `.model-pill-btn`, `.model-pill-list`, `.model-pill-item` styles.
- **Remove** (now-obsolete): `.chat-input-row`, `.chat-input-row textarea`, `.chat-input-row button`, the `.chat-model-selector` family (`.chat-model-label`, `.chat-model-select`, `.chat-model-input`, `.chat-model-fetch-btn`), and `.attach-btn`.
- **Fix** the latent specificity bug by consolidating all bottom-bar button styling under the dedicated `.composer-*-btn` classes (no more `.chat-input-row button` catch-all overriding `.attach-btn`).

## Files

- New: `frontend/src/components/ChatComposer.tsx`
- New: `frontend/src/components/ModelSelectPill.tsx`
- Modified: `frontend/src/components/ChatPanel.tsx`
- Modified: `frontend/src/components/ChatToolbar.tsx`
- Modified: `frontend/src/index.css`

## Verification

- `npm run typecheck` — the type gate (there is no lint script).
- `npm test` — existing Vitest suite must stay green.
- E2E (Playwright + mock LLM, no real key): run backend `:8000`, frontend `:5173`, mock `:5050`, then `python tools/drive.py` (chat/paper scenario) and `python tools/drive_titles.py` (title-gen) — confirm chat send, paper-view chat, and title generation still work. The `mock_llm.py` title-sniffing contract is untouched.
- Manual checks:
  - Type a long message → box grows toward ~8 lines → caps and shows a native scrollbar; wheel + ↑/↓ browse the typed text.
  - Delete text → box shrinks back to 2 lines.
  - Drag the paper-view divider → textarea height re-measures on width change (no drift).
  - Model pill opens, highlights the current model, selects a new one, closes on outside-click/Escape.
  - ContextRing still updates and its popover still works (capacity / reserve controls intact).

## Risks / Notes

- `ContextRing`'s `systemPrompt` prop is load-bearing: in paper view it carries the full PDF text, which dominates the token count. It must stay wired through the composer to the ring.
- Today there are two model selectors in paper view (one in `ChatPanel`, one in `ChatToolbar`); consolidating to the single pill in the composer removes the redundancy. Both currently write `Conversation.model` via `updateSettings`, so behavior is preserved.
- Auto-grow JS runs per keystroke (set height `auto` → read `scrollHeight` → set height) — negligible cost; the `ResizeObserver` prevents width-reflow drift.
