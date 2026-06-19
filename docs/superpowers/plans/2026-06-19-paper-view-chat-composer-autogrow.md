# Unified Chat Composer with Auto-Growing Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared `ChatPanel`'s fixed `rows={1}` textarea with a unified rounded container: a 2-line-initial auto-growing textarea that caps at `min(40vh, 240px)` then scrolls natively, over a fixed bottom bar holding `[attach][model pill] … [context ring][send]`, applied to both general chat and paper view.

**Architecture:** Two new components — `ChatComposer` (the unified container + auto-grow textarea) and `ModelSelectPill` (a custom dropdown capsule). `ChatPanel` becomes a thin orchestrator passing state/callbacks in as props. The `ContextRing` is reused as-is. The redundant model selector in `ChatToolbar`'s ⚙ dropdown is removed.

**Tech Stack:** React + TypeScript, Vite, Zustand, plain CSS (no CSS framework). Tests: Vitest in `environment: node`, `*.test.ts` only — **no jsdom / no @testing-library/react installed**, so DOM rendering is NOT unit-tested; pure logic is TDD'd, DOM + visual behavior is verified by `npm run typecheck` + the existing Playwright E2E rig (`tools/drive.py`, `tools/drive_titles.py`).

## Global Constraints

- **Type gate is `npm run typecheck`** (`tsc --noEmit`). There is **no lint script**; typecheck is the gate. Frontend commands run from `frontend/`.
- **Test runner:** `npm test` (Vitest), `environment: "node"`, `include: ["src/**/*.test.ts"]`. Tests are pure-logic `.ts` files only. Do NOT add jsdom / @testing-library — out of scope.
- **Do not re-enable React.StrictMode** (`src/main.tsx`) — double-mounting aborts in-flight SSE streams.
- **Do not touch the `tools/mock_llm.py` title-sniffing contract** (sniffs system prompt for `"title generator"` + `"paper being discussed"`).
- **No backend / data-flow / storage / ContextRing-math changes.**
- Work in the `chat-composer` worktree (already created); commit after each task.
- CSS tokens available: `--accent`, `--accent-2`, `--accent-contrast`, `--accent-soft`, `--bg`, `--bg-2`, `--bg-3`, `--bg-4`, `--border`, `--text`, `--text-dim`, `--radius-sm/md/lg`, `--shadow-sm/md`, `--transition-fast`.
- `ModelInfo` type (`src/types.ts:119`): `{ id: string; context_length?: number; ... }`.

## File Structure

- **New:** `frontend/src/components/ModelSelectPill.tsx` — custom dropdown capsule. Self-contained, only React state.
- **New:** `frontend/src/components/ChatComposer.tsx` — the unified container: auto-grow textarea + fixed bottom bar (attach, ModelSelectPill, ContextRing, send). Owns textarea ref + auto-grow effect + ResizeObserver.
- **New:** `frontend/src/lib/chatComposer.ts` — pure function `computeTextareaHeight(scrollHeight, min, max)` extracted for TDD.
- **New:** `frontend/src/lib/chatComposer.test.ts` — Vitest tests for the pure function.
- **Modify:** `frontend/src/components/ChatPanel.tsx` — remove `.chat-model-selector` row (`:394-432`) and `.chat-input-row` block (`:433-478`); render `<ChatComposer …/>` below `.chat-status`. Keep `effectiveSystemPrompt`, handlers, hidden file input.
- **Modify:** `frontend/src/components/ChatToolbar.tsx` — remove the Model section (`:102-125`), its `fetchModels` effect (`:50-58`), and now-unused `models`/`loadingModels` state + `onModelChange` prop.
- **Modify:** `frontend/src/views/PaperView.tsx` — drop the `onModelChange` prop from `<ChatToolbar>` (becomes unused).
- **Modify:** `frontend/src/index.css` — add `.chat-composer*` / `.composer-*-btn` / `.model-pill*` styles; remove obsolete `.chat-input-row*`, `.chat-model-selector*`, `.attach-btn`.

---

## Task 1: Pure height-clamp helper (TDD)

**Files:**
- Create: `frontend/src/lib/chatComposer.ts`
- Test: `frontend/src/lib/chatComposer.test.ts`

**Interfaces:**
- Produces: `computeTextareaHeight(scrollHeight: number, min: number, max: number): number` — returns `Math.min(max, Math.max(min, scrollHeight))`. Used by Task 3.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/chatComposer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeTextareaHeight } from "./chatComposer";

describe("computeTextareaHeight", () => {
  it("clamps below the minimum to the minimum", () => {
    expect(computeTextareaHeight(20, 60, 240)).toBe(60);
  });

  it("returns scrollHeight when within [min, max]", () => {
    expect(computeTextareaHeight(120, 60, 240)).toBe(120);
  });

  it("clamps above the maximum to the maximum", () => {
    expect(computeTextareaHeight(500, 60, 240)).toBe(240);
  });

  it("equals min when scrollHeight equals min", () => {
    expect(computeTextareaHeight(60, 60, 240)).toBe(60);
  });

  it("equals max when scrollHeight equals max", () => {
    expect(computeTextareaHeight(240, 60, 240)).toBe(240);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/chatComposer.test.ts`
Expected: FAIL — "Cannot find module './chatComposer'".

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/chatComposer.ts`:

```ts
/** Clamp a textarea's measured scrollHeight into [min, max].
 *
 *  Used by ChatComposer's auto-grow effect: the textarea is set to
 *  scrollHeight when content grows, but never below the 2-line minimum
 *  (empty input) and never above the cap (at which point the textarea's
 *  own overflow-y:auto takes over and the user scrolls natively). */
export function computeTextareaHeight(
  scrollHeight: number,
  min: number,
  max: number
): number {
  return Math.min(max, Math.max(min, scrollHeight));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/chatComposer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/chatComposer.ts frontend/src/lib/chatComposer.test.ts
git commit -m "feat(chat): add computeTextareaHeight clamp helper"
```

---

## Task 2: ModelSelectPill component

**Files:**
- Create: `frontend/src/components/ModelSelectPill.tsx`

**Interfaces:**
- Consumes: `ModelInfo` from `../types` (`{ id: string; ... }`).
- Produces: `ModelSelectPill` component — props:
  ```ts
  {
    models: { id: string }[];
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
  }
  ```
  Used by Task 3 (`ChatComposer`).

**Note:** No unit test (DOM component, jsdom not installed). Verified by typecheck + E2E. Behavior: button shows `value ▾`; click toggles a popover; current model row marked ✓; outside-click + Escape close; ↑/↓ moves a highlight index, Enter selects, Escape closes. Empty `models` → render a text `<input>` (parity with old behavior).

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/ModelSelectPill.tsx`:

```tsx
import { useState, useRef, useEffect, useCallback } from "react";

interface Props {
  models: { id: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

/** Custom dropdown capsule showing the current model id with a ▾.
 *  Click opens a list; the current model is checked ✓. Closes on
 *  outside-click or Escape. Keyboard: ↑/↓ moves the highlight, Enter
 *  selects, Escape closes. Falls back to a text <input> when the model
 *  list is empty (parity with the old native-select behavior for
 *  providers that expose no model list). */
export function ModelSelectPill({ models, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Reset highlight to the current model whenever the list opens.
  useEffect(() => {
    if (open) {
      const idx = models.findIndex((m) => m.id === value);
      setHighlight(idx >= 0 ? idx : 0);
    }
  }, [open, models, value]);

  const choose = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange]
  );

  function onKey(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(models.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = models[highlight];
      if (m) choose(m.id);
    }
  }

  // Empty list → text input (parity with old behavior).
  if (models.length === 0) {
    return (
      <input
        className="model-pill-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model id"
        title="Model for this conversation"
        disabled={disabled}
      />
    );
  }

  return (
    <div className="model-pill" ref={wrapRef}>
      <button
        type="button"
        className="model-pill-btn"
        title="Select model for this conversation"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
      >
        <span className="model-pill-name">{value || "model"}</span>
        <span className="model-pill-caret">▾</span>
      </button>
      {open && (
        <ul className="model-pill-list" role="listbox">
          {models.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={m.id === value}
              className={`model-pill-item ${i === highlight ? "highlighted" : ""} ${
                m.id === value ? "selected" : ""
              }`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => choose(m.id)}
            >
              <span className="model-pill-check">{m.id === value ? "✓" : ""}</span>
              <span className="model-pill-id">{m.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (no errors). The component is unused so far but compiles.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ModelSelectPill.tsx
git commit -m "feat(chat): add ModelSelectPill dropdown capsule"
```

---

## Task 3: ChatComposer component (unified container + auto-grow)

**Files:**
- Create: `frontend/src/components/ChatComposer.tsx`

**Interfaces:**
- Consumes: `computeTextareaHeight` from `../lib/chatComposer` (Task 1); `ModelSelectPill` (Task 2); `ContextRing` from `./ContextRing`; `Attachment` type from `../types`.
- Produces: `ChatComposer` component — props:
  ```ts
  {
    value: string;
    onValueChange: (v: string) => void;
    onSend: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onPaste: (e: React.ClipboardEvent) => void;
    onAttach: () => void;
    busy: boolean;
    placeholder: string;
    attachments: Attachment[];
    onRemoveAttachment: (index: number) => void;
    models: { id: string }[];
    currentModel: string;
    onModelChange: (id: string) => void;
    conversationId: string;
    systemPrompt: string;
  }
  ```
  Used by Task 5 (`ChatPanel`).

**Behavior recap:** textarea starts at 2 lines (~60px min), grows to `scrollHeight`, caps at `min(40vh, 240px)` then `overflow-y:auto`; a `ResizeObserver` re-measures on width change (paper-view divider drag). Container = big rounded box, NO internal divider. Bottom bar (fixed): left `[attach][model pill]`, right `[ContextRing][send]`. Attachment previews render inside the container above the bar.

- [ ] **Step 1: Implement the component**

Create `frontend/src/components/ChatComposer.tsx`:

```tsx
import { useLayoutEffect, useRef, useEffect, useCallback } from "react";
import type { Attachment } from "../types";
import { computeTextareaHeight } from "../lib/chatComposer";
import { ModelSelectPill } from "./ModelSelectPill";
import { ContextRing } from "./ContextRing";

interface Props {
  value: string;
  onValueChange: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onAttach: () => void;
  busy: boolean;
  placeholder: string;
  attachments: Attachment[];
  onRemoveAttachment: (index: number) => void;
  models: { id: string }[];
  currentModel: string;
  onModelChange: (id: string) => void;
  conversationId: string;
  systemPrompt: string;
}

// 2-line minimum; cap = min(40vh, 240px). Both in px; the cap is resolved
// against the live viewport so a tall window allows ~8 lines.
const MIN_HEIGHT = 60;
const MAX_HEIGHT_VH = 40; // percent of viewport height
const MAX_HEIGHT_PX = 240;

function maxForViewport(): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return Math.min(MAX_HEIGHT_PX, Math.round((vh * MAX_HEIGHT_VH) / 100));
}

export function ChatComposer({
  value,
  onValueChange,
  onSend,
  onKeyDown,
  onPaste,
  onAttach,
  busy,
  placeholder,
  attachments,
  onRemoveAttachment,
  models,
  currentModel,
  onModelChange,
  conversationId,
  systemPrompt,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Re-measure on value change and on mount: shrink to auto first so a
  // deleted line lets the box collapse, then grow to scrollHeight (clamped).
  const measure = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = computeTextareaHeight(ta.scrollHeight, MIN_HEIGHT, maxForViewport());
    ta.style.height = `${next}px`;
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [value, measure]);

  // Re-measure when the column width changes (paper-view divider drag
  // reflows line wrapping) or the viewport height changes (cap depends on vh).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(ta);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  const canSend = !busy && (value.trim().length > 0 || attachments.length > 0);

  return (
    <div className="chat-composer">
      <div className="chat-composer-input">
        <textarea
          ref={taRef}
          className="composer-textarea"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={2}
          disabled={busy}
        />
      </div>

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((att, i) => (
            <div key={i} className="composer-attachment">
              <img src={att.data_url} alt={att.name || "attachment"} />
              <button
                className="composer-attachment-remove"
                onClick={() => onRemoveAttachment(i)}
                title="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-composer-bar">
        <div className="chat-composer-bar-left">
          <button
            type="button"
            className="composer-icon-btn composer-attach-btn"
            title="Attach image"
            onClick={onAttach}
            disabled={busy}
          >
            {/* circle wrapping a logo */}
            <span className="composer-attach-glyph" aria-hidden>＋</span>
          </button>
          <ModelSelectPill
            models={models}
            value={currentModel}
            onChange={onModelChange}
            disabled={busy}
          />
        </div>
        <div className="chat-composer-bar-right">
          <ContextRing conversationId={conversationId} systemPrompt={systemPrompt} />
          <button
            type="button"
            className="composer-icon-btn composer-send-btn"
            title="Send (Enter)"
            onClick={onSend}
            disabled={!canSend}
          >
            {/* paper-plane / up arrow */}
            <span className="composer-send-glyph" aria-hidden>➤</span>
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (`Attachment` type must have `data_url` + `name` — verify against `src/types.ts`; if `name` is optional the `att.name || "attachment"` already handles it.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ChatComposer.tsx
git commit -m "feat(chat): add ChatComposer unified container with auto-grow"
```

---

## Task 4: CSS for the composer, pill, and buttons; remove obsolete rules

**Files:**
- Modify: `frontend/src/index.css` — replace `.chat-input-row*` (`:397-407`) and `.chat-model-selector*` (`:364-394`) rules; remove `.attach-btn` (`:775-780`); add new composer/pill styles.

**Note:** No test. Verified visually via E2E + typecheck (CSS isn't typechecked, but the page must render). Keep the attachment-remove styling — it moves to `.composer-attachment-remove`.

- [ ] **Step 1: Remove obsolete CSS rules**

In `frontend/src/index.css`, **delete** these rule blocks exactly:
- The "Model selector (chat panel)" comment + `.chat-model-selector` through `.chat-model-fetch-btn:hover` (lines `:364-394`).
- `.chat-input-row` through `.chat-input-row button:disabled` (lines `:397-407`).
- `.attach-btn`, `.attach-btn:hover`, `.attach-btn:disabled` (lines `:775-780`).
- The `.attachment-previews`, `.attachment-preview`, `.attachment-preview img`, `.attachment-remove` block (lines `:758-774`) — these are superseded by composer-internal equivalents below. (`.msg-attachments` / `.msg-attachment-img` at `:781-782` are KEPT — they style sent-message attachments, not the composer.)

- [ ] **Step 2: Add the new styles**

In `frontend/src/index.css`, in place of the deleted `.chat-input-row*` block (just before the "Paper cards" section comment), insert:

```css
/* ---------- Chat composer (unified input container) ---------- */
.chat-composer {
  display: flex; flex-direction: column;
  margin: 0 auto; width: 100%; max-width: 820px;
  padding: 8px 20px 10px;
  background: var(--bg);
}
.chat-composer-input {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-2);
  overflow: hidden; /* keeps the rounded corners on the textarea */
}
.composer-textarea {
  display: block; width: 100%;
  min-height: 60px; /* 2 lines */
  resize: none; overflow-y: auto;
  padding: 10px 12px;
  border: none; background: transparent;
  color: var(--text); font-size: 14px; line-height: 1.5; font-family: inherit;
}
.composer-textarea:focus { outline: none; }
.composer-textarea::placeholder { color: var(--text-dim); }

/* Attachment previews inside the composer (above the bar). */
.composer-attachments {
  display: flex; gap: 6px; flex-wrap: wrap;
  padding: 8px 2px 0;
}
.composer-attachment {
  position: relative; width: 56px; height: 56px;
  border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border);
}
.composer-attachment img { width: 100%; height: 100%; object-fit: cover; }
.composer-attachment-remove {
  position: absolute; top: 2px; right: 2px; width: 16px; height: 16px;
  border-radius: 50%; border: none; background: rgba(0,0,0,0.7); color: white;
  cursor: pointer; font-size: 12px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}

/* Fixed bottom bar — no divider above it. */
.chat-composer-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 2px 2px;
}
.chat-composer-bar-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.chat-composer-bar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Small circular icon buttons (attach + send). */
.composer-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0;
  border-radius: 50%; border: 1px solid var(--border);
  background: var(--bg-3); color: var(--text);
  cursor: pointer; font-size: 15px; flex-shrink: 0;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.composer-icon-btn:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-4); }
.composer-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.composer-send-btn {
  background: var(--accent-2); color: var(--accent-contrast); border-color: transparent;
}
.composer-send-btn:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent-2); }
.composer-attach-glyph, .composer-send-glyph { line-height: 1; }

/* ---------- Model pill (dropdown capsule) ---------- */
.model-pill { position: relative; flex-shrink: 0; }
.model-pill-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 10px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--bg-3); color: var(--text);
  cursor: pointer; font-size: 12px; font-family: inherit; max-width: 220px;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}
.model-pill-btn:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-4); }
.model-pill-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.model-pill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-pill-caret { opacity: 0.7; }
.model-pill-input {
  padding: 5px 8px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text);
  font-size: 12px; font-family: inherit; min-width: 120px;
}
.model-pill-input:focus { border-color: var(--accent); outline: none; }
.model-pill-list {
  position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 20;
  min-width: 100%; max-width: 280px; max-height: 260px; overflow-y: auto;
  margin: 0; padding: 4px; list-style: none;
  border-radius: var(--radius-md); border: 1px solid var(--border);
  background: var(--bg-2); box-shadow: var(--shadow-md);
}
.model-pill-item {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border-radius: var(--radius-sm);
  font-size: 12px; cursor: pointer; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.model-pill-item.highlighted { background: var(--bg-4); }
.model-pill-item.selected { color: var(--accent); }
.model-pill-check { width: 12px; flex-shrink: 0; }
.model-pill-id { overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 3: Typecheck + build sanity**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

Run: `cd frontend && npm run build`
Expected: succeeds (CSS is bundled; confirms no syntax error broke the build).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(chat): composer + model-pill styles; drop obsolete input-row/model-selector/attach-btn"
```

---

## Task 5: Wire ChatComposer into ChatPanel

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx` — replace lines `:394-478` (the model-selector row + chat-input-row + attachment previews) with a single `<ChatComposer …/>`. Add `ChatComposer` import. The hidden `<input type=file>` + `fileInputRef` + `handleFileSelect` + `handlePaste` + `onKey` + `send` + `handleModelChange` stay; only the JSX mount changes.

**Interfaces:**
- Consumes: `ChatComposer` (Task 3).
- Produces: the refactored `ChatPanel` (used by `ChatView` + `PaperView`, unchanged).

- [ ] **Step 1: Add the import**

In `frontend/src/components/ChatPanel.tsx`, after the `ContextRing` import (line `:22`), add:

```tsx
import { ChatComposer } from "./ChatComposer";
```

- [ ] **Step 2: Replace the input JSX**

In `frontend/src/components/ChatPanel.tsx`, **delete** the entire block from the `{/* Model selector */}` comment (line `:394`) through the end of the attachment-previews block (line `:478`), and replace it with:

```tsx
      <ChatComposer
        value={input}
        onValueChange={setInput}
        onSend={() => send()}
        onKeyDown={onKey}
        onPaste={handlePaste}
        onAttach={() => fileInputRef.current?.click()}
        busy={busy}
        placeholder={busy ? "…" : "Message…  (Enter to send, Shift+Enter newline, Ctrl+V to paste images)"}
        attachments={attachments}
        onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
        models={availableModels}
        currentModel={currentModel}
        onModelChange={handleModelChange}
        conversationId={c.id}
        systemPrompt={effectiveSystemPrompt}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={handleFileSelect}
      />
```

Rationale: the hidden file input moves out of the old row (it was nested in `.chat-input-row`) to sit just under the composer; `fileInputRef` + `handleFileSelect` are unchanged. `availableModels`, `currentModel`, `handleModelChange`, `effectiveSystemPrompt`, `c.id` are all already in scope (declared at `:194-205`).

- [ ] **Step 3: Typecheck + full test suite**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

Run: `cd frontend && npm test`
Expected: all green (the new `chatComposer.test.ts` + existing suites; nothing in ChatPanel is unit-tested, so no regressions).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ChatPanel.tsx
git commit -m "feat(chat): wire ChatComposer into ChatPanel, drop old input row + model-selector row"
```

---

## Task 6: Remove the redundant model selector from ChatToolbar

**Files:**
- Modify: `frontend/src/components/ChatToolbar.tsx` — remove the Model section (`:102-125`), the `fetchModels` effect (`:50-58`), the `models`/`loadingModels` state (`:40-41`), the `fetchModels` import (`:10`), the `ModelInfo` import (if now unused — check `STYLE_PRESETS`/`StylePreset` stay), and the `onModelChange` prop (`:21` + destructure `:30`). Style + Theme sections remain.
- Modify: `frontend/src/views/PaperView.tsx` — remove the `onModelChange={...}` prop passed to `<ChatToolbar>` (`:154`).

**Interfaces:**
- Consumes: the refactored `ChatPanel` (Task 5) which now owns model selection via the pill.
- Produces: a `ChatToolbar` with one fewer prop.

- [ ] **Step 1: Trim ChatToolbar**

In `frontend/src/components/ChatToolbar.tsx`:
1. Remove the import `import { fetchModels } from "../lib/api";` (line `:10`).
2. In the `import { STYLE_PRESETS, type StylePreset, type ModelInfo } from "../types";` line, drop `, type ModelInfo` (it's only used by the removed state). Result: `import { STYLE_PRESETS, type StylePreset } from "../types";`
3. Remove the `onModelChange: (model: string) => void;` line from `Props` (`:21`).
4. Remove `onModelChange,` from the destructure (`:30`).
5. Remove the `const [models, setModels] = useState<ModelInfo[]>([]);` and `const [loadingModels, setLoadingModels] = useState(false);` lines (`:40-41`).
6. Remove the entire `useEffect` that fetches models (`:50-58`).
7. Remove `const currentModel = activeConv?.model || provider?.model || "";` (`:71`) — now unused. (Leave `currentStyle`.)
8. Remove the whole `{/* Model selector */}` settings-section block (`:102-125`) inside the dropdown menu.

After this, the dropdown menu starts directly with the `{/* Style preset */}` section.

- [ ] **Step 2: Drop the now-unused prop in PaperView**

In `frontend/src/views/PaperView.tsx`, remove the line:
```tsx
  onModelChange={(m) => updateSettings(convIdState, { model: m })}
```
(from the `<ChatToolbar …/>` JSX around line `:154`). `updateSettings` remains used elsewhere in PaperView? — check; if `updateSettings` becomes unused, leave it imported only if still referenced (it's also used by the composer path indirectly via `ChatPanel`, but PaperView's own `updateSettings` binding to the toolbar is what's removed). Run typecheck to catch any unused-import error.

- [ ] **Step 3: Typecheck + tests**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (Watch for: unused `updateSettings` import in PaperView, unused `provider` in ChatToolbar — `provider` is still used for `currentModel`? No, that line was removed. Re-check: `provider` in ChatToolbar is declared at `:35` and was only consumed by the removed `currentModel` and the fetch effect. If now unused, typecheck flags `provider` as unused → remove that line too.)

Run: `cd frontend && npm test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ChatToolbar.tsx frontend/src/views/PaperView.tsx
git commit -m "refactor(chat): drop redundant model selector from ChatToolbar (now in composer)"
```

---

## Task 7: E2E verification (Playwright + mock LLM)

**Files:** none modified — verification only.

**Context:** Three servers must run. The mock LLM (`tools/mock_llm.py`) sniffs title-generation requests by the system-prompt phrases `"title generator"` + `"paper being discussed"` — untouched by this change. Run in the `Agent_env` conda env (per global Python rule).

- [ ] **Step 1: Start the three servers (background, separate shells)**

In shell A (backend):
```bash
cd backend && ./run.sh
```
In shell B (frontend):
```bash
cd frontend && npm run dev
```
In shell C (mock LLM, in `Agent_env`):
```bash
conda activate Agent_env && python tools/mock_llm.py
```
(If `Agent_env` is already active, skip `conda activate`.) Wait until each reports it's listening (`:8000`, `:5173`, `:5050`).

- [ ] **Step 2: Run the chat/paper scenario driver**

Run: `python tools/drive.py`
Expected: completes without error; chat send + paper-view chat work. (Visually confirm in any screenshots it captures: the input is a single rounded container, the bottom bar shows the attach circle, model pill, context ring, and send button.)

- [ ] **Step 3: Run the title-generation driver**

Run: `python tools/drive_titles.py`
Expected: completes; titles are generated (mock routes title requests correctly — the title system-prompt phrases are unchanged).

- [ ] **Step 4: Run the context-ring driver (ring still works inside the composer)**

Run: `python tools/drive_context_ring.py`
Expected: completes; the context ring renders and its popover opens inside the composer.

- [ ] **Step 5: Manual smoke checks (browser at http://localhost:5173)**

Confirm each:
1. **General chat:** type a short message → box is ~2 lines. Type ~15 lines of text → box grows toward ~8 lines then stops and shows a native scrollbar; mouse wheel + ↑/↓ browse the typed text. Delete text → box shrinks back to 2 lines.
2. **Paper view** (`/paper/<some-id>`): same auto-grow; **drag the PDF/chat divider** → textarea height re-measures (no drift / no leftover empty space).
3. **Model pill:** click → list opens, current model checked ✓; click another → switches; click outside or press Escape → closes; ↑/↓ + Enter works.
4. **Context ring:** shows a %, click → popover opens with capacity/reserve controls.
5. **Send button:** disabled when input empty & no attachments; enabled otherwise; Enter sends.
6. **Attach:** click circle → file picker; pick an image → preview appears inside the composer above the bar; remove (×) works; paste an image (Ctrl+V) also adds a preview.
7. **No duplicate model selector** in paper view's ⚙ dropdown (only Style + Theme remain).

- [ ] **Step 6: Final typecheck + tests**

Run: `cd frontend && npm run typecheck && npm test`
Expected: PASS / all green.

- [ ] **Step 7: Commit nothing** (verification-only task). If any check failed, fix in the responsible task and re-commit there.

---

## Self-Review (run after writing — done)

**Spec coverage:**
- Auto-grow (initial 2 lines, grow, cap `min(40vh,240px)`, native scroll, wheel/↑↓) → Task 1 (clamp) + Task 3 (effect + `overflow-y:auto`) + Task 4 (`min-height:60px`). ✓
- Width-change re-measure (divider drag) → Task 3 `ResizeObserver`. ✓
- Unified container, no internal divider → Task 4 `.chat-composer` (no `border-top` on `.chat-composer-bar`). ✓
- Bottom bar `[attach][model pill] … [context ring][send]` → Task 3 JSX. ✓
- Model pill custom dropdown with ✓/outside-click/keyboard → Task 2. ✓
- ContextRing reused as-is, `systemPrompt` forwarded → Task 3 + Task 5 (`systemPrompt={effectiveSystemPrompt}`). ✓
- Remove redundant ChatToolbar model selector → Task 6. ✓
- `.chat-status` unchanged, above container → Task 5 leaves `:391-393` intact. ✓
- Attachment previews inside container → Task 3 + Task 4 `.composer-attachments`. ✓
- Files list matches spec → ✓.

**Placeholder scan:** none — all steps have concrete code/commands. The one soft spot is Task 6 Step 3's note about possibly-unused `provider`/`updateSettings`; that's a real typecheck-driven decision, not a placeholder, and the step says to let typecheck decide and remove if flagged.

**Type consistency:** `computeTextareaHeight(scrollHeight, min, max)` (Task 1) matches its call in Task 3. `ModelSelectPill` props (Task 2) match the usage in Task 3. `ChatComposer` props (Task 3) match the usage in Task 5. `Attachment` (`data_url`, `name`) matches Task 3's `att.data_url`/`att.name`. ✓
