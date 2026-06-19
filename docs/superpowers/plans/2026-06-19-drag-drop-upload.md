# Drag-and-Drop Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag an image file onto the chat composer to attach it (staging a thumbnail), feeding the existing `FileReader → Attachment → image_url` pipeline — no backend change.

**Architecture:** Add a drop entry point to `ChatComposer` (the live auto-grow composer). A new `onDropFiles` prop flows dropped image files up to `ChatPanel`, where a single shared `addFiles` callback (also adopted by the existing paste/click handlers) encodes them via `FileReader` into `Attachment[]`. A pure `pickImageFiles` helper in `lib/chatComposer.ts` partitions dropped files into images (kept) vs. non-images (a "仅支持图片" toast). Overlay + toast are CSS-driven.

**Tech Stack:** React 18 + TypeScript, Vitest (`environment: node`, `src/**/*.test.ts`), plain CSS (`index.css`, theme variables), Playwright (Python sync API, `tools/`). No new dependencies.

## Global Constraints

- **Image-only contract** for drag-drop, click, and paste: gate is `file.type.startsWith("image/")`, matching the hidden `<input type="file" accept="image/*" multiple>`. Non-images are never staged.
- **Drop target = the `.chat-composer` box only.** Dragging over the message list triggers the browser default (not prevented).
- **Dropping while `busy`** (LLM streaming) stages the attachment but does not send — send is already disabled while `busy`. Drop handlers are not gated on `busy`.
- **No backend, types, store, or db changes.** `Attachment` / `ChatMessage` shapes are unchanged and already multimodal-ready.
- **Type gate is `npm run typecheck`** (`tsc --noEmit`). There is **no lint script** — do not invent one.
- **Colors use existing theme CSS variables** (`var(--accent)`, `var(--bg-2)`, `var(--bg-3)`, `var(--border)`) so all themes get correct contrast.
- **React.StrictMode is disabled** (`src/main.tsx`) — double-mounting aborts in-flight SSE. Drag handlers must be stable (cleanup timers on unmount) but do not need StrictMode double-invoke hardening beyond normal cleanup.
- **Work in a fresh worktree** under `.claude/worktrees/` per repo convention; `frontend/node_modules` is a junction to the main repo's — usually no `npm install` needed.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `frontend/src/lib/chatComposer.ts` | Pure helpers for the composer: `computeTextareaHeight` (existing) + new `pickImageFiles`. | Modify |
| `frontend/src/lib/chatComposer.test.ts` | Unit tests for both pure helpers. | Modify |
| `frontend/src/components/ChatPanel.tsx` | Owns `attachments` state + ingest. Extract `addFiles`; rewrite `handlePaste`/`handleFileSelect` to use it; add `handleDropFiles`; pass `onDropFiles` to `<ChatComposer>`. | Modify |
| `frontend/src/components/ChatComposer.tsx` | Controlled composer. Add `onDropFiles` prop, drag state, 4 drag handlers, overlay + reject-toast JSX. | Modify |
| `frontend/src/index.css` | `position: relative` on `.chat-composer`; add `.chat-composer-drop-overlay` + `.chat-composer-reject-toast`. | Modify |

No new files outside tests. The E2E check (Task 6) is run manually / via a small driver; it does not require a committed test file unless the driver is added to `tools/`.

---

## Task 1: Pure `pickImageFiles` helper + unit tests

**Files:**
- Modify: `frontend/src/lib/chatComposer.ts` (append to existing file)
- Test: `frontend/src/lib/chatComposer.test.ts` (append to existing file)

**Interfaces:**
- Produces: `pickImageFiles(files: File[]): { images: File[]; rejected: File[] }` — pure, synchronous. Task 3 (`ChatComposer` drop handler) consumes it.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/chatComposer.test.ts` (after the existing `computeTextareaHeight` describe block, before EOF):

```ts
import { pickImageFiles } from "./chatComposer";

describe("pickImageFiles", () => {
  const img = (name: string) => new File(["x"], name, { type: "image/png" });
  const other = (name: string, type = "text/plain") =>
    new File(["x"], name, { type });

  it("keeps all images, rejects nothing, when every file is an image", () => {
    const { images, rejected } = pickImageFiles([img("a.png"), img("b.jpg")]);
    expect(images.map((f) => f.name)).toEqual(["a.png", "b.jpg"]);
    expect(rejected).toEqual([]);
  });

  it("rejects all non-images", () => {
    const { images, rejected } = pickImageFiles([other("a.txt"), other("b.pdf", "application/pdf")]);
    expect(images).toEqual([]);
    expect(rejected.map((f) => f.name)).toEqual(["a.txt", "b.pdf"]);
  });

  it("partitions a mixed list, preserving input order within each bucket", () => {
    const { images, rejected } = pickImageFiles([
      img("a.png"),
      other("b.txt"),
      img("c.gif", ) && new File(["x"], "c.gif", { type: "image/gif" }),
    ]);
    expect(images.map((f) => f.name)).toEqual(["a.png", "c.gif"]);
    expect(rejected.map((f) => f.name)).toEqual(["b.txt"]);
  });

  it("returns empty buckets for an empty list", () => {
    const { images, rejected } = pickImageFiles([]);
    expect(images).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("treats a file with an empty MIME type as rejected", () => {
    const blank = new File(["x"], "no-mime.bin", { type: "" });
    const { images, rejected } = pickImageFiles([blank]);
    expect(images).toEqual([]);
    expect(rejected.map((f) => f.name)).toEqual(["no-mime.bin"]);
  });
});
```

> Note: the `c.gif` line uses `&&` only to inline-construct a `image/gif` file in the array literal (the helper `img()` hardcodes `image/png`). If that reads awkwardly, replace it with a direct `new File(["x"], "c.gif", { type: "image/gif" })` element — both are equivalent; pick the direct form for clarity.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/lib/chatComposer.test.ts`
Expected: FAIL — `pickImageFiles` is not exported from `./chatComposer` (import error / "is not a function").

- [ ] **Step 3: Write the minimal implementation**

Append to `frontend/src/lib/chatComposer.ts` (after the existing `computeTextareaHeight`):

```ts
/** Partition dragged/pasted files into images (kept) and non-images (rejected).
 *
 *  `image/*` MIME is the gate, matching the <input accept="image/*"> contract
 *  used by the attach button. Pure + synchronous so it is trivially unit-
 *  testable; the drag-drop handler in ChatComposer calls this to decide what
 *  to stage (images) vs. surface a "仅支持图片" toast for (rejected). */
export function pickImageFiles(
  files: File[]
): { images: File[]; rejected: File[] } {
  const images: File[] = [];
  const rejected: File[] = [];
  for (const f of files) {
    (f.type.startsWith("image/") ? images : rejected).push(f);
  }
  return { images, rejected };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/chatComposer.test.ts`
Expected: PASS — all `computeTextareaHeight` tests still pass (regression) + 5 new `pickImageFiles` tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/chatComposer.ts frontend/src/lib/chatComposer.test.ts
git commit -m "feat(composer): add pure pickImageFiles helper + tests"
```

---

## Task 2: Shared `addFiles` in `ChatPanel` (dedupe paste/click)

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx:147-187` (replace the two handlers; insert `addFiles`)

**Interfaces:**
- Consumes: `setAttachments` (existing state setter at `ChatPanel.tsx:106`).
- Produces: `addFiles(files: File[]): void` (a `useCallback`) and `handleDropFiles: (files: File[]) => void` (a thin wrapper) — both consumed by Task 3 via the new `onDropFiles` prop.

- [ ] **Step 1: Replace the two existing handlers with a shared `addFiles` + thin wrappers**

In `frontend/src/components/ChatPanel.tsx`, replace the block currently at lines 147–187 (the `handlePaste` comment + `handlePaste` + `handleFileSelect` comment + `handleFileSelect`) with:

```ts
  // Shared ingest: encode image File(s) to base64 data URLs and append to
  // attachments. Image-only (matches <input accept="image/*">); non-images
  // are silently skipped — callers that want a rejection signal (drag-drop)
  // call pickImageFiles first and pass only images here.
  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setAttachments((prev) => [
          ...prev,
          { type: "image", data_url: dataUrl, name: file.name },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  // Handle paste — extract images from clipboard (silent skip for non-images).
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    let hadImage = false;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        hadImage = true;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (hadImage) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  // Handle file input (click to upload).
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) addFiles(Array.from(files));
    e.target.value = ""; // reset so the same file can be re-selected
  }, [addFiles]);

  // Handle drag-and-drop (image-only; ChatComposer pre-filters via pickImageFiles
  // and shows a toast for rejected files before calling this).
  const handleDropFiles = useCallback((files: File[]) => {
    addFiles(files);
  }, [addFiles]);
```

Behavior preserved: `handlePaste` still calls `e.preventDefault()` only when an image item was present (matches the original, which prevented default inside the image branch); `handleFileSelect` still resets `e.target.value`. Non-image paste/click files are silently skipped by `addFiles`, exactly as before.

- [ ] **Step 2: Run the type gate**

Run: `cd frontend && npm run typecheck`
Expected: PASS with no errors. (`handleDropFiles` is defined but not yet used — TS does not error on unused `const` unless `noUnusedLocals` is on. If it IS on and errors, that will resolve in Task 3 when `handleDropFiles` is passed as a prop. Do not suppress; proceed to Task 3.)

- [ ] **Step 3: Run the unit tests (regression sanity)**

Run: `cd frontend && npm test`
Expected: PASS — existing tests unaffected.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ChatPanel.tsx
git commit -m "refactor(composer): extract shared addFiles; dedupe paste/click ingest"
```

---

## Task 3: Drag-drop handlers + overlay/toast in `ChatComposer`

**Files:**
- Modify: `frontend/src/components/ChatComposer.tsx` (imports, Props, component body, JSX)

**Interfaces:**
- Consumes: `pickImageFiles` from `../lib/chatComposer` (Task 1).
- Produces: a `ChatComposer` that accepts a new required prop `onDropFiles: (files: File[]) => void` and renders drag overlay + reject toast. `ChatPanel` (Task 4) supplies `onDropFiles={handleDropFiles}`.

- [ ] **Step 1: Update imports**

In `frontend/src/components/ChatComposer.tsx`, replace line 1:

```ts
import { useLayoutEffect, useRef, useEffect, useCallback } from "react";
```

with:

```ts
import { useLayoutEffect, useRef, useEffect, useCallback, useState } from "react";
```

And replace line 3:

```ts
import { computeTextareaHeight } from "../lib/chatComposer";
```

with:

```ts
import { computeTextareaHeight, pickImageFiles } from "../lib/chatComposer";
```

- [ ] **Step 2: Add `onDropFiles` to the Props interface**

In the same file, replace the `Props` interface (lines 7–23):

```ts
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
```

with:

```ts
interface Props {
  value: string;
  onValueChange: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onAttach: () => void;
  onDropFiles: (files: File[]) => void;
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

- [ ] **Step 3: Destructure the new prop**

In the same file, replace the destructure block (lines 36–52):

```ts
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
```

with (adding `onDropFiles`):

```ts
export function ChatComposer({
  value,
  onValueChange,
  onSend,
  onKeyDown,
  onPaste,
  onAttach,
  onDropFiles,
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
```

- [ ] **Step 4: Add drag state + reject-toast state after the `taRef` declaration**

In the same file, replace:

```ts
  const taRef = useRef<HTMLTextAreaElement>(null);
```

with:

```ts
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Drag-and-drop state. dragCounter ref solves the nested-element flicker:
  // dragenter on a child fires before dragleave on the parent, so counting
  // enters/leaves and clearing the overlay only at zero avoids strobing as
  // the cursor crosses the textarea / previews / bar children.
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const [rejectToast, setRejectToast] = useState<string | null>(null);
  const rejectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel any pending reject-toast timer on unmount.
  useEffect(() => {
    return () => {
      if (rejectTimer.current) clearTimeout(rejectTimer.current);
    };
  }, []);
```

- [ ] **Step 5: Add the four drag handlers (before `const canSend = ...`)**

In the same file, insert immediately before the line `const canSend = !busy && (value.trim().length > 0 || attachments.length > 0);`:

```ts
  // Only treat drags carrying real files as drop candidates; ignore text/link
  // drags so normal in-textarea drag-drop of selections is unaffected.
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // required to permit the drop
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const { images, rejected } = pickImageFiles(files);
      if (images.length > 0) onDropFiles(images);
      if (rejected.length > 0) {
        // Restart the timer so back-to-back rejects show one steady toast.
        if (rejectTimer.current) clearTimeout(rejectTimer.current);
        setRejectToast("仅支持图片");
        rejectTimer.current = setTimeout(() => {
          setRejectToast(null);
          rejectTimer.current = null;
        }, 2500);
      }
    },
    [onDropFiles]
  );
```

- [ ] **Step 6: Wire the handlers onto `.chat-composer` and render overlay + toast**

In the same file, replace the opening of the returned JSX:

```tsx
  return (
    <div className="chat-composer">
      <div className="chat-composer-input">
```

with:

```tsx
  return (
    <div
      className={`chat-composer${dragOver ? " drag-active" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="chat-composer-drop-overlay" aria-hidden>
          <span>⬇ 松开以添加图片</span>
        </div>
      )}
      <div className="chat-composer-input">
```

Then, in the same file, insert the reject-toast render block **immediately before** the closing `</div>` of `.chat-composer` (i.e. right after the `.chat-composer-bar` block's closing `</div>` and before the final `</div>`). The current tail is:

```tsx
        </div>
      </div>
    </div>
  );
}
```

Replace it with:

```tsx
        </div>
      </div>
      {rejectToast && (
        <div className="chat-composer-reject-toast" role="status">
          {rejectToast}
        </div>
      )}
    </div>
  );
}
```

> The reject-toast renders as the last flex child of `.chat-composer` (after `.chat-composer-bar`), in normal flow — it briefly expands the box by ~24px for 2.5s and unmounts when cleared. The overlay is absolute (Task 4 CSS), so its JSX position is irrelevant.

- [ ] **Step 7: Run the type gate**

Run: `cd frontend && npm run typecheck`
Expected: FAIL — `ChatPanel.tsx` passes `<ChatComposer>` without the now-required `onDropFiles` prop (Task 4 fixes it). This expected failure confirms the prop is required and wired. Do not commit yet; proceed to Task 4.

> If the error is instead inside `ChatComposer.tsx` (e.g. an unused `onDropFiles` in destructure), re-check Step 3 and Step 5. The only acceptable failure at this step is the missing-prop error in `ChatPanel.tsx`.

---

## Task 4: Pass `onDropFiles` from `ChatPanel`; verify types + tests

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx` (the `<ChatComposer>` JSX, ~lines 394–410)

**Interfaces:**
- Consumes: `handleDropFiles` from Task 2; `onDropFiles` prop on `<ChatComposer>` from Task 3.

- [ ] **Step 1: Add the `onDropFiles` prop to the `<ChatComposer>` usage**

In `frontend/src/components/ChatPanel.tsx`, find the `<ChatComposer ... />` JSX (currently around lines 394–410). Add `onDropFiles={handleDropFiles}` alongside the other props. The prop block currently is:

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
```

Replace with (one line added after `onAttach`):

```tsx
      <ChatComposer
        value={input}
        onValueChange={setInput}
        onSend={() => send()}
        onKeyDown={onKey}
        onPaste={handlePaste}
        onAttach={() => fileInputRef.current?.click()}
        onDropFiles={handleDropFiles}
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
```

- [ ] **Step 2: Run the type gate — expect PASS now**

Run: `cd frontend && npm run typecheck`
Expected: PASS — no errors. (Both `ChatComposer` now receives `onDropFiles`, and `handleDropFiles` is now used.)

- [ ] **Step 3: Run the unit tests**

Run: `cd frontend && npm test`
Expected: PASS — all suites green, including the Task 1 `pickImageFiles` tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ChatComposer.tsx frontend/src/components/ChatPanel.tsx
git commit -m "feat(composer): drag-and-drop image upload onto .chat-composer"
```

---

## Task 5: CSS — drop overlay + reject toast

**Files:**
- Modify: `frontend/src/index.css:371-378` (add `position: relative` to `.chat-composer`) and append new rules near the `.chat-composer` block.

**Interfaces:** None (CSS only).

- [ ] **Step 1: Add `position: relative` to `.chat-composer`**

In `frontend/src/index.css`, replace:

```css
.chat-composer {
  display: flex; flex-direction: column;
  margin: 0 auto 10px; width: 100%; max-width: 820px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-2);
}
```

with:

```css
.chat-composer {
  display: flex; flex-direction: column;
  margin: 0 auto 10px; width: 100%; max-width: 820px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-2);
  position: relative; /* anchor for the drop overlay */
}
```

- [ ] **Step 2: Add overlay + toast + active-border rules**

Append the following block immediately after the `.chat-composer:focus-within { border-color: var(--accent); }` rule (line 379):

```css
/* Drag-over affordance: tints the whole composer with a dashed accent border
   and a centered prompt. pointer-events:none so the drop lands on the
   container, not the overlay. */
.chat-composer.drag-active {
  border-color: var(--accent);
}
.chat-composer-drop-overlay {
  position: absolute; inset: 0;
  border: 2px dashed var(--accent);
  border-radius: var(--radius-lg);
  background: var(--accent-soft);
  display: flex; align-items: center; justify-content: center;
  color: var(--accent); font-size: 14px; font-weight: 600;
  pointer-events: none;
  z-index: 2;
}
/* Reject toast: in-flow flex child, briefly expands the composer. */
.chat-composer-reject-toast {
  margin-top: 6px;
  padding: 4px 8px;
  align-self: center;
  font-size: 12px; color: var(--text-dim);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
```

- [ ] **Step 3: Run the type gate (unchanged) + unit tests (unchanged)**

Run: `cd frontend && npm run typecheck && npm test`
Expected: PASS (CSS changes don't affect TS/Vitest, but confirms no accidental edit to a `.ts`/`.tsx` file).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css
git commit -m "style(composer): drop overlay + reject-toast styles"
```

---

## Task 6: Manual + E2E verification

**Files:** None modified (verification only; optionally create `tools/drive_drop.py`).

**Interfaces:** None.

The drag interaction cannot be exercised by Vitest (no real DOM drop). Verify via the mock-LLM Playwright rig.

- [ ] **Step 1: Start the three servers (three terminals)**

```bash
# Terminal 1 — backend
cd backend && ./run.sh
# Terminal 2 — frontend
cd frontend && npm run dev
# Terminal 3 — mock LLM (Agent_env)
python tools/mock_llm.py
```

Confirm: backend `:8000`, frontend `:5173`, mock LLM `:5050` all running.

- [ ] **Step 2: Manual smoke test in the browser**

Open `http://localhost:5173`. Create a new chat. Then:
1. Drag a real PNG from the file explorer onto the composer → confirm the "⬇ 松开以添加图片" overlay appears on drag-over and a thumbnail stages on drop.
2. Drag a `.txt` file onto the composer → confirm the "仅支持图片" toast appears for ~2.5s and **no** thumbnail stages.
3. Type a message + Enter → confirm the image is sent and the user bubble shows the image (`.msg-attachment-img`); the mock LLM logs an `image_url` content part.
4. While a response is streaming (`busy`), drag another PNG → confirm it stages (send stays disabled until streaming completes).
5. Open a paper view (`/paper/<id>`) → repeat step 1 there to confirm the shared `ChatComposer` drops in both flows.

- [ ] **Step 3 (optional but recommended): automated E2E via Playwright**

Create `tools/drive_drop.py` (standalone, mirrors the `tools/drive_*.py` pattern):

```python
# tools/drive_drop.py — verify drag-drop image upload against the mock LLM rig.
# Run after backend :8000 + frontend :5173 + mock_llm :5050 are up.
import base64
from playwright.sync_api import sync_playwright

# 1x1 transparent PNG.
PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page()
        page.goto("http://localhost:5173")
        page.wait_for_selector(".chat-composer")

        # Build a DataTransfer carrying the PNG as a File, then dispatch drop.
        page.evaluate(
            """(pngB64) => {
                const bytes = Uint8Array.from(atob(pngB64), c => c.charCodeAt(0));
                const file = new File([bytes], "drop.png", { type: "image/png" });
                const dt = new DataTransfer();
                dt.items.add(file);
                const el = document.querySelector(".chat-composer");
                el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
                el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
                el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
            }""",
            PNG_B64,
        )

        # A staged thumbnail should appear inside the composer.
        page.wait_for_selector(".composer-attachment", timeout=3000)
        print("OK: dropped image staged as .composer-attachment")
        browser.close()

if __name__ == "__main__":
    main()
```

Run: `python tools/drive_drop.py` (in `Agent_env`)
Expected: prints `OK: dropped image staged as .composer-attachment`.

> If you'd rather not add a committed driver, Step 2's manual check is sufficient. The driver is offered for repeatability.

- [ ] **Step 4: Final full-test + typecheck sweep**

Run: `cd frontend && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit (only if `tools/drive_drop.py` was added)**

```bash
git add tools/drive_drop.py
git commit -m "test(e2e): drag-drop image upload driver"
```

- [ ] **Step 6: Merge back to `main` per repo workflow**

Per `CLAUDE.md`: the worktree change is ready to merge into `main`. After a clean merge, remove the worktree (delete the `frontend/node_modules` junction first — `rmdir` the link, never recursively delete a junctioned `node_modules`; kill any orphaned `vite` process first) and push to the remote.

---

## Self-Review

**1. Spec coverage:**
- §3 decision 1 (composer-only drop target) → Task 3 `hasFiles` + handlers on `.chat-composer`; Step 2 manual check confirms message-list drop is default. ✓
- §3 decision 2 (non-image toast) → Task 3 `onDrop` rejected branch + Task 5 `.chat-composer-reject-toast`. ✓
- §3 decision 3 (busy allows staging) → Task 3 handlers not gated on `busy`; manual Step 2.4 verifies. ✓
- §3 decision 4 (multiple files, drag order) → `pickImageFiles` preserves order (Task 1 test); `addFiles` appends in iteration order. ✓
- §4.1 `pickImageFiles` → Task 1. ✓
- §4.2 `addFiles` + dedupe → Task 2. ✓
- §4.3 drag handlers + `dragCounter` + reject timer + overlay/toast JSX → Task 3. ✓
- §4.4 CSS (`position: relative`, overlay in-flow toast) → Task 5. ✓
- §5 data flow → covered end-to-end by Tasks 2–4 + manual/E2E. ✓
- §6 error handling (non-image, zero-file, rapid re-drop) → Task 1 empty test + Task 3 timer-reset; zero-file is a no-op (images.length 0 && rejected.length 0). ✓
- §7 testing (typecheck, unit, E2E) → Tasks 1, 4, 6. ✓
- §8 files touched → all five present. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. The `c.gif` `&&` trick in Task 1 Step 1 is flagged with a cleaner alternative in a note — acceptable.

**3. Type consistency:** `pickImageFiles(File[]): {images, rejected}` (Task 1) consumed in Task 3 `onDrop`. `onDropFiles: (files: File[]) => void` (Task 3 Props) supplied by `handleDropFiles` (Task 2) in Task 4. `addFiles(files: File[])` (Task 2) shared by `handlePaste`/`handleFileSelect`/`handleDropFiles`. Names match across tasks. ✓

No gaps found. Plan is complete.
