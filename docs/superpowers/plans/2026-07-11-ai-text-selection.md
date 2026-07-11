# AI PDF Text Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paper reader select text in the PDF and send the excerpt, with page provenance, to the active paper chat through an `Ask AI` floating control.

**Architecture:** A small pure helper normalizes selection text and creates the user prompt. `PdfViewer` observes PDF text-layer selections and emits an eligible selection through a local callback. `PaperView` owns a one-shot pending prompt and `ChatPanel` consumes it through its existing `send` function, so no server API or global state is introduced.

**Tech Stack:** React 18, TypeScript, pdf.js text layer, Vitest, existing CSS custom properties.

---

## File structure

- Create: `frontend/src/lib/selectedTextAskAi.ts` — selection normalization, page validation, and prompt creation; free of React state.
- Create: `frontend/src/lib/selectedTextAskAi.test.ts` — unit tests for the helper behavior.
- Create: `frontend/src/components/SelectedTextAskAi.tsx` — browser-selection listener and floating button.
- Modify: `frontend/src/components/PdfViewer.tsx` — expose the selected-text callback and mount the controller above PDF pages.
- Modify: `frontend/src/views/PaperView.tsx` — hold a pending prompt and bridge PDF callback to paper chat.
- Modify: `frontend/src/components/ChatPanel.tsx` — consume one pending prompt using the established `send` path.
- Modify: `frontend/src/index.css` — button position, palette, focus and disabled styling.

### Task 1: Selection prompt helper

**Files:**
- Create: `frontend/src/lib/selectedTextAskAi.ts`
- Create: `frontend/src/lib/selectedTextAskAi.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { buildSelectedTextPrompt, normalizeSelectedText } from "./selectedTextAskAi";

it("normalizes a PDF excerpt and limits its length", () => {
  expect(normalizeSelectedText("  A\n\n  B\tC  ", 100)).toBe("A B C");
  expect(normalizeSelectedText("abcdefgh", 5)).toBe("abcde…");
});

it("builds a page-grounded question with a quoted excerpt", () => {
  expect(buildSelectedTextPrompt("a useful result", 4)).toBe(
    "Please explain this excerpt from page 4 of the paper:\n\n> a useful result"
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/selectedTextAskAi.test.ts`

Expected: FAIL because `./selectedTextAskAi` does not exist.

- [ ] **Step 3: Write the minimal helper**

```ts
export const MAX_SELECTED_TEXT_LENGTH = 2_000;

export function normalizeSelectedText(text: string, maxLength = MAX_SELECTED_TEXT_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export function buildSelectedTextPrompt(text: string, pageNumber: number): string {
  return `Please explain this excerpt from page ${pageNumber} of the paper:\n\n> ${text}`;
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npx vitest run src/lib/selectedTextAskAi.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/lib/selectedTextAskAi.ts frontend/src/lib/selectedTextAskAi.test.ts
git commit -m "feat: add selected text prompt helper"
```

### Task 2: Floating PDF selection controller

**Files:**
- Create: `frontend/src/components/SelectedTextAskAi.tsx`
- Modify: `frontend/src/components/PdfViewer.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Write the failing pure eligibility test**

Extend `frontend/src/lib/selectedTextAskAi.test.ts` with:

```ts
import { findSelectedPdfPage } from "./selectedTextAskAi";

it("accepts a selection contained in one PDF page and rejects other elements", () => {
  expect(findSelectedPdfPage({ closest: () => ({ dataset: { pageNumber: "7" } }) } as unknown as Element)).toBe(7);
  expect(findSelectedPdfPage({ closest: () => null } as unknown as Element)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/selectedTextAskAi.test.ts`

Expected: FAIL because `findSelectedPdfPage` is not exported.

- [ ] **Step 3: Implement the eligibility helper and controller**

Add this helper to `selectedTextAskAi.ts`:

```ts
export function findSelectedPdfPage(node: Element): number | null {
  const page = node.closest<HTMLElement>(".pdf-page-wrap[data-page-number]");
  const value = Number(page?.dataset.pageNumber);
  return Number.isInteger(value) && value > 0 ? value : null;
}
```

Create `SelectedTextAskAi` with props `{ disabled: boolean; onAsk: (prompt: string) => void }`. On `mouseup`, read `window.getSelection()`, require a non-collapsed range whose start and end containers resolve to the same PDF page, normalize `selection.toString()`, and position a portal-free absolute button within the matching `.pdf-page-canvas-wrap`. The button must use `onMouseDown={event => event.preventDefault()}`; on click it must call `onAsk(buildSelectedTextPrompt(text, pageNumber))`, clear the selection, and dismiss itself. Escape and an outside pointer-down must dismiss the pending control.

In `PdfPage`, add `data-page-number={pageNumber}` to `.pdf-page-wrap`. Add the optional prop `onAskSelectedText?: (prompt: string) => void` to `PdfViewer`, then render the controller as a child of `.pdf-scroll`, passing `disabled={!onAskSelectedText}`.

Add a `.selected-text-ask-ai` rule with an accent background, readable foreground, 4px radius, compact 12px label, a shadow, and a focus-visible outline; it must have a z-index above `.pdf-textlayer`.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `npx vitest run src/lib/selectedTextAskAi.test.ts; npm run typecheck`

Expected: all selected-text tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/lib/selectedTextAskAi.ts frontend/src/lib/selectedTextAskAi.test.ts frontend/src/components/SelectedTextAskAi.tsx frontend/src/components/PdfViewer.tsx frontend/src/index.css
git commit -m "feat: add Ask AI control for PDF selections"
```

### Task 3: Deliver the prompt to the current paper conversation

**Files:**
- Modify: `frontend/src/views/PaperView.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`

- [ ] **Step 1: Add a failing behavioral test for the one-shot payload contract**

Create `frontend/src/lib/selectedTextAskAi.integration.test.ts` around a small exported `consumePendingPrompt` helper, asserting that a non-empty prompt is consumed once and that an empty prompt is ignored:

```ts
expect(consumePendingPrompt("question", false)).toEqual({ prompt: "question", consumed: true });
expect(consumePendingPrompt("", false)).toEqual({ prompt: null, consumed: false });
expect(consumePendingPrompt("question", true)).toEqual({ prompt: null, consumed: false });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/selectedTextAskAi.integration.test.ts`

Expected: FAIL because `consumePendingPrompt` does not exist.

- [ ] **Step 3: Implement the bridge and one-shot consumption**

Export `consumePendingPrompt` from `selectedTextAskAi.ts` using the exact contract in the failing test.

In `PaperView`, add `const [pendingSelectedTextPrompt, setPendingSelectedTextPrompt] = useState<string | null>(null)`; pass `onAskSelectedText={setPendingSelectedTextPrompt}` to `PdfViewer`, and pass the state plus a callback that clears it to `ChatPanel`.

Extend `ChatPanel` props with `pendingPrompt?: string | null` and `onPendingPromptConsumed?: () => void`. In an effect that observes the pending prompt and `busy`, call `consumePendingPrompt`; when it returns a prompt, clear the parent state first and call `void send(prompt)`. This reuses provider resolution, aborts, history persistence, streaming, and error display. Do not modify the composer draft while a prompt is pending.

- [ ] **Step 4: Run focused tests and frontend gate**

Run: `npx vitest run src/lib/selectedTextAskAi.test.ts src/lib/selectedTextAskAi.integration.test.ts; npm run typecheck; npm test`

Expected: all tests pass, typecheck exits 0, and the full suite remains green.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/lib/selectedTextAskAi.ts frontend/src/lib/selectedTextAskAi.integration.test.ts frontend/src/views/PaperView.tsx frontend/src/components/ChatPanel.tsx
git commit -m "feat: send selected PDF text to paper chat"
```

### Task 4: Manual browser regression check

**Files:**
- No source changes expected.

- [ ] **Step 1: Start the sanctioned local stack**

Run the backend with Windows-native `run.bat`, frontend with `npm run dev`, and mock LLM with `C:\\Users\\Delig\\.conda\\envs\\Agent_env\\python.exe tools/mock_llm.py`.

- [ ] **Step 2: Verify the interaction**

Open a paper thread, select text on one rendered PDF page, verify that exactly one `Ask AI` button appears beside the selection, activate it, and verify one page-labelled user message plus streamed response. Verify Escape dismisses the control, a cross-page selection does not create a control, and highlight mode continues to expose only its color palette.

- [ ] **Step 3: Commit only if the manual check revealed a necessary fix**

```powershell
git add <changed-files>
git commit -m "fix: polish PDF selection ask interaction"
```

## Plan self-review

- Spec coverage: Task 1 covers text normalization, caps, and prompt format; Task 2 covers valid single-page selection, positioning, dismissal, disabled state, and styling; Task 3 covers local data flow, immediate send, and no draft overwrite; Task 4 covers browser and annotation regressions.
- Placeholder scan: no TBD/TODO items or unnamed validation steps remain.
- Type consistency: `PdfViewer.onAskSelectedText` emits a `string`; `PaperView.pendingSelectedTextPrompt` stores `string | null`; `ChatPanel.pendingPrompt` consumes the same `string`.
