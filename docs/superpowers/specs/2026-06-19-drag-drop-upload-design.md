# Drag-and-Drop Image Upload — Design

**Date:** 2026-06-19
**Status:** Approved (brainstorming complete)
**Scope:** Frontend only. The backend is a stateless CORS proxy and is not touched.

## 1. Problem

The chat composer lets users attach images by clicking the `＋` attach button or pasting (Ctrl+V). Both feed a fully-wired pipeline (`FileReader` → base64 data URL → `Attachment[]` → OpenAI `image_url` content part → `/api/llm` proxy). There is no drag-and-drop entry point: a user who drags an image file onto the composer gets the browser default (the file opens / navigates away) instead of an attachment. The request is to make dropping an image onto the composer attach it, with no extra clicks.

## 2. Verified current state (the integration target)

> Note: an earlier exploration pass reported the composer refactor as "designed but not implemented." That was wrong. The refactor **is live**. This section reflects the actual code as of 2026-06-19.

- **`frontend/src/components/ChatComposer.tsx`** renders the composer as a single `.chat-composer` container:
  ```
  .chat-composer                 ← drop target (this whole box)
    .chat-composer-input
      <textarea>                 ← auto-growing, rows={2}
    .composer-attachments        ← (conditional) thumbnail previews of staged attachments
    .chat-composer-bar
      .chat-composer-bar-left:   ＋(attach)  [ModelSelectPill]
      .chat-composer-bar-right:  [ContextRing]  ➤(send)
  ```
  `ChatComposer` is a controlled component: it owns **no** attachment state. It receives `onAttach` (fires the hidden file input), `onPaste`, `attachments`, and `onRemoveAttachment` from `ChatPanel`.
- **`frontend/src/components/ChatPanel.tsx`** owns the attachment state and the two existing ingest paths:
  - `attachments: Attachment[]` state (≈ line 106).
  - `handlePaste` (≈ 148–167) — reads `clipboardData.items`, filters `image/*`, `FileReader.readAsDataURL`, appends to `attachments`.
  - `handleFileSelect` (≈ 170–187) — same logic over `<input type="file">` `.files`.
  - The hidden `<input type="file" accept="image/*" multiple>` (≈ 411–418) lives in `ChatPanel`.
  - The two handlers duplicate the identical `File → Attachment` encoding.
- **`frontend/src/lib/chatComposer.ts`** exists with one pure helper (`computeTextareaHeight`). It is the natural home for a new pure, unit-testable helper.
- **`frontend/src/types.ts`** — `Attachment { type: "image"; data_url: string; name?: string }`, `ChatMessage.attachments?: Attachment[]`. Multimodal-ready; no schema change needed.
- **`frontend/src/lib/llm.ts`** `runConversation` (≈ 86–110) already converts `attachments` into OpenAI `image_url` content parts. Vision is wired end-to-end.
- **`frontend/src/index.css`** — `.chat-composer` (≈ 371–378) is `display: flex; flex-direction: column` with `border`/`border-radius`/`background: var(--bg-2)` and a `:focus-within { border-color: var(--accent) }` rule. It has **no `position`** (defaults to `static`) — the overlay needs `position: relative`.
- There is **zero** existing drag-and-drop infrastructure anywhere in `frontend/src` (no `onDrop`/`onDragOver`/`DataTransfer`). The only "drag" code is the paper-view panel divider (mouse-driven, unrelated).

## 3. Design decisions (confirmed with user)

1. **Drop target = the composer input area only** (the `.chat-composer` box), not the whole chat panel. Dragging over the message list does nothing special (browser default). This is the user's explicit choice and keeps the feature focused.
2. **Non-image files** dropped are not silently ignored — show a brief "仅支持图片" toast (~2.5s). Dragging a file and getting no feedback is poor UX.
3. **During `busy`** (LLM streaming): dropping is **allowed** — it only stages attachments; send is already disabled while busy. Staging while waiting is more convenient than blocking.
4. **Multiple files**: supported, appended in drag order (matches the `multiple` attach input and paste behavior).
5. **Image-only contract**: drag-drop, click, and paste all accept `image/*` only. Dragging a web `<img>` element (not a local file) is out of scope — consistent with the existing two paths which only handle `File` objects.
6. **No new dependency.** Plain React drag handlers + CSS.

## 4. Approach

Minimal, local change mirroring the existing paste/click pattern. One new prop on `ChatComposer`, one extracted shared helper in `ChatPanel`, one pure helper in `lib/chatComposer.ts`, and a small CSS addition.

### 4.1 Pure helper — `lib/chatComposer.ts`

Add a pure, synchronous, unit-testable function:

```ts
/** Partition dragged/pasted files into images (kept) and non-images (rejected).
 *  `image/*` MIME is the gate, matching the <input accept="image/*"> contract. */
export function pickImageFiles(files: File[]): { images: File[]; rejected: File[] } {
  const images: File[] = [];
  const rejected: File[] = [];
  for (const f of files) {
    (f.type.startsWith("image/") ? images : rejected).push(f);
  }
  return { images, rejected };
}
```

This is the testable seam: it has no async/FileReader, so it is trivially unit-testable. The drag handler calls it to decide what to stage vs. toast.

### 4.2 Shared ingest — `ChatPanel.tsx`

Extract the duplicated `File → Attachment` encoding into one callback used by all three entry points:

```ts
const addFiles = useCallback((files: File[]) => {
  for (const file of files) {
    // image-only contract; callers (paste/click/drop) already pre-filter,
    // but guard anyway so a stray non-image can't become a broken attachment.
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setAttachments((prev) => [...prev, { type: "image", data_url: dataUrl, name: file.name }]);
    };
    reader.readAsDataURL(file);
  }
}, []);
```

`handlePaste` and `handleFileSelect` are rewritten to pass their files straight to `addFiles` — the image-only guard inside `addFiles` preserves their current silent-skip behavior for non-images byte-for-byte (paste/click have no toast; only drop does). This eliminates the existing duplication between the two handlers. A new `handleDropFiles = (files: File[]) => addFiles(files)` is passed to `ChatComposer` as `onDropFiles`.

> `addFiles` is image-only and fire-and-forget (returns void). The "rejected" toast decision lives entirely in `ChatComposer` (section 4.3), which calls `pickImageFiles` *before* invoking `onDropFiles(images)` — so only `ChatComposer` needs to know about rejections, and `ChatPanel` keeps a clean images-only contract. Paste/click bypass `pickImageFiles` entirely: they hand `addFiles` everything and let it silently skip, exactly as today.

### 4.3 Drop interaction + feedback — `ChatComposer.tsx`

Add a new **required** prop:

```ts
onDropFiles: (files: File[]) => void;   // images only; caller pre-filters
```

Local state in `ChatComposer`:

- `const [dragOver, setDragOver] = useState(false)` — drives the overlay.
- `const dragCounter = useRef(0)` — solves the classic nested-element flicker: `dragenter` on a child fires before `dragleave` on the parent, so counting enters/leaves and only clearing the overlay at zero avoids the overlay strobing as the cursor crosses textarea/preview/bar children.
- `const [rejectToast, setRejectToast] = useState<string | null>(null)` — the "仅支持图片" message; cleared by a `setTimeout` (~2500ms) tracked in a ref and cleared on unmount/retimer.

Drag handlers attached to the `.chat-composer` div:

| Handler | Behavior |
|---|---|
| `onDragEnter` | If `e.dataTransfer.types.includes("Files")`: `preventDefault()`, `dragCounter.current++`, `setDragOver(true)`. Otherwise (text/link drag) do nothing — normal text-drop behavior preserved. |
| `onDragOver` | If Files: `preventDefault()` (required to permit drop) and set `e.dataTransfer.dropEffect = "copy"`. |
| `onDragLeave` | `dragCounter.current--`; if `<= 0`, reset to 0 and `setDragOver(false)`. |
| `onDrop` | `preventDefault()`; `dragCounter.current = 0`; `setDragOver(false)`; read `Array.from(e.dataTransfer.files)`; `const { images, rejected } = pickImageFiles(files)`; if `images.length` → `onDropFiles(images)`; if `rejected.length` → `setRejectToast("仅支持图片")` (restart the 2500ms timer). |

`busy` does **not** gate drop (decision 3). The handlers run regardless of `busy`; staging via `onDropFiles → addFiles → setAttachments` is independent of send.

Render (inside `.chat-composer`):

```tsx
{rejectToast && (
  <div className="chat-composer-reject-toast" role="status">{rejectToast}</div>
)}
{/* placed as a flex child between .composer-attachments and .chat-composer-bar
    so it briefly expands the box; it unmounts when rejectToast clears */}
{dragOver && (
  <div className="chat-composer-drop-overlay" aria-hidden>
    <span>⬇ 松开以添加图片</span>
  </div>
)}
{/* overlay is absolute + pointer-events:none, so its JSX position is irrelevant */}
```

The overlay is `pointer-events: none` so the drop event still lands on the container (not the overlay div). The overlay is absolutely positioned within `.chat-composer` (which gains `position: relative`); the reject-toast is in normal flow.

### 4.4 CSS — `index.css`

- Add `position: relative;` to `.chat-composer` (currently static). No other change to the base rule.
- `.chat-composer-drop-overlay` — absolute, `inset: 0`, `border-radius` matching the container, semi-transparent `var(--bg-2)` wash + dashed `var(--accent)` border, flex-centered prompt in `var(--accent)`, `pointer-events: none`, `z-index` above the textarea/previews but below nothing external. Tints the whole composer as the drop affordance.
- `.chat-composer-reject-toast` — **in-flow** (a flex-column child of `.chat-composer`, rendered between `.composer-attachments` and `.chat-composer-bar`), so it just expands the composer by ~24px for the 2.5s it shows — no absolute positioning, no overlap with the textarea or send button, no z-index. Small font, centered, `var(--bg-3)` bg + `var(--border)` + rounded. It is unmounted when `rejectToast` is null; a short CSS transition on opacity softens the appear/disappear.
- All colors use existing theme variables so every theme (dark/light/solarized/nord/gruvbox/dracula/rose-pine/tokyo-night) gets correct contrast for free.

### 4.5 Out of scope

- Non-image file types (PDF, etc.) — image-only, matching paste/click.
- Dropping web `<img>` elements / URLs — only `File` objects, matching paste/click.
- Whole-panel drop target — explicitly declined (decision 1).
- The composer auto-grow refactor — already shipped; untouched.
- Backend — no change (stateless proxy passes `image_url` content parts through unchanged).
- Document-level `preventDefault` to stop files dropped outside the composer from opening — **not** added (would interfere with normal page behavior). A known minor wart: a file dropped on the message list triggers the browser default. Accepted per decision 1.

## 5. Data flow (drop → send)

```
user drops image(s) on .chat-composer
  → ChatComposer onDrop: pickImageFiles(files) → images
  → onDropFiles(images)  [prop, into ChatPanel]
  → addFiles(images)     [ChatPanel, shared with paste/click]
  → FileReader.readAsDataURL per image → setAttachments([...prev, {...}])
  → ChatComposer re-renders with new .composer-attachments thumbnail
user clicks Send (or Enter)
  → ChatPanel.send(): userMsg = { role:"user", content: text||null, attachments }
  → appendMessages → IDB; runConversation
  → llm.ts converts attachments → [{type:"image_url", image_url:{url: dataUrl}}]
  → streamChat → /api/llm proxy → provider
```

Identical to the existing click/paste path from `addFiles` onward.

## 6. Error handling

- **Non-image drop:** toast, no attachment created. No error state.
- **FileReader failure** (rare — corrupt file): the existing paste/click paths already silently drop on `reader.onload` never firing; drag-drop inherits this. Not worth special-casing (no regression vs. current behavior).
- **Drop with zero files** (e.g. a folder with no readable items): `images.length === 0 && rejected.length === 0` → nothing staged, no toast, overlay dismissed. Clean no-op.
- **Rapid re-drops / repeated rejects:** the toast timer is reset each time (cleared + restarted in the ref), so back-to-back rejects show one steady toast, not a stack.

## 7. Testing

- **Type gate:** `npm run typecheck` (this is the project's gate — there is no lint script).
- **Unit test:** add `frontend/src/lib/chatComposer.test.ts` (or extend an existing test file) covering `pickImageFiles`: all-images / all-rejected / mixed / empty. Pure function, no async, fast.
- **E2E (mock LLM rig):** the drag interaction is verified via Playwright by dispatching a synthetic `drop` event on `.chat-composer` with a `DataTransfer` carrying a tiny inline PNG:
  1. Backend `:8000`, frontend `:5173`, mock LLM `:5050` running.
  2. `page.dispatchEvent(".chat-composer", "dragenter", …)` then `drop` with a 1×1 PNG `File`.
  3. Assert `.composer-attachment` thumbnail appears (staged).
  4. Type a message, send, assert the user bubble's `.msg-attachments` contains the image and the mock LLM received an `image_url` content part.
  - This can be a one-off check in an existing `tools/drive_*.py` driver or a small dedicated `tools/drive_drop.py`; the implementation plan will decide. Not blocking the design.
- **Manual sanity:** drag a PNG onto the composer (overlay appears → thumbnail stages → sends); drag a `.txt` (toast shows, nothing stages); drag while a response is streaming (stages, send disabled until done).

## 8. Files touched

| File | Change |
|---|---|
| `frontend/src/lib/chatComposer.ts` | + `pickImageFiles` pure helper. |
| `frontend/src/components/ChatPanel.tsx` | Extract `addFiles`; rewrite `handlePaste`/`handleFileSelect` to use it; add `handleDropFiles`; pass `onDropFiles` to `<ChatComposer>`. |
| `frontend/src/components/ChatComposer.tsx` | + `onDropFiles` prop; `dragOver`/`dragCounter`/`rejectToast` state; four drag handlers; overlay + toast JSX. |
| `frontend/src/index.css` | `position: relative` on `.chat-composer`; + `.chat-composer-drop-overlay`, `.chat-composer-reject-toast`. |
| `frontend/src/lib/chatComposer.test.ts` (new) | Unit tests for `pickImageFiles`. |

No backend, types, store, or db changes.

## 9. Survives the (already-shipped) composer refactor

The composer refactor the earlier exploration worried about is already live, so there is no migration concern. The drop surface is `.chat-composer`, which is the stable container. `addFiles`/`pickImageFiles`/`onDropFiles` are independent of composer internals, so future composer tweaks (e.g. moving the bar) do not affect drag-drop.
