# Selected PDF Text Context Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace immediate Ask AI submission with a removable selected-text context card that users can combine with a custom prompt.

**Architecture:** Keep the selected excerpt structured as `SelectedPdfTextPayload` from PDF selection through `PaperView`, `ChatPanel`, and `ChatComposer`. Serialize it to the existing string message format only when the user explicitly sends. Preserve conversation binding in `PaperView` and avoid backend changes.

**Tech Stack:** React 18, TypeScript, Vitest, Playwright, existing CSS theme tokens.

---

### Task 1: Structured context and message helpers

**Files:**
- Modify: `frontend/src/lib/selectedTextAskAi.ts`
- Modify: `frontend/src/lib/selectedTextAskAi.test.ts`
- Delete: `frontend/src/lib/selectedTextAskAi.integration.test.ts`

- [ ] **Step 1: Write failing helper tests**

Replace prompt-oriented assertions with:

```ts
expect(buildSelectedTextMessage({ text: "result", pageNumber: 4 }, "Why?")).toBe(
  "Excerpt from page 4:\n\n> result\n\nWhy?"
);
expect(buildSelectedTextMessage({ text: "line one\nline two", pageNumber: 2 }, "")).toBe(
  "Excerpt from page 2:\n\n> line one\n> line two\n\nPlease explain this excerpt."
);

const pending = {
  conversationId: "a",
  context: { text: "result", pageNumber: 4 },
};
expect(pendingContextForConversation(pending, "a")).toEqual(pending.context);
expect(pendingContextForConversation(pending, "b")).toBeNull();
```

Remove the obsolete `consumePendingPrompt` integration test.

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/selectedTextAskAi.test.ts`

Expected: FAIL because `buildSelectedTextMessage` and `pendingContextForConversation` are missing.

- [ ] **Step 3: Implement the structured contract**

In `selectedTextAskAi.ts`:

```ts
export interface PendingSelectedTextContext {
  conversationId: string;
  context: SelectedPdfTextPayload;
}

export function buildSelectedTextMessage(
  context: SelectedPdfTextPayload,
  userPrompt: string,
): string {
  const quoted = context.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  const prompt = userPrompt.trim() || "Please explain this excerpt.";
  return `Excerpt from page ${context.pageNumber}:\n\n${quoted}\n\n${prompt}`;
}

export function pendingContextForConversation(
  pending: PendingSelectedTextContext | null,
  conversationId: string | null,
): SelectedPdfTextPayload | null {
  return pending?.conversationId === conversationId ? pending.context : null;
}
```

Remove `buildSelectedTextPrompt`, `PendingSelectedTextPrompt`,
`consumePendingPrompt`, and `pendingPromptForConversation`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/lib/selectedTextAskAi.test.ts`

Expected: selected-text helper tests pass.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/lib/selectedTextAskAi.ts frontend/src/lib/selectedTextAskAi.test.ts frontend/src/lib/selectedTextAskAi.integration.test.ts
git commit -m "refactor: keep selected PDF text structured"
```

### Task 2: Composer send eligibility and context card

**Files:**
- Modify: `frontend/src/lib/chatComposer.ts`
- Modify: `frontend/src/lib/chatComposer.test.ts`
- Modify: `frontend/src/components/ChatComposer.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Write the failing eligibility tests**

```ts
expect(canSubmitComposer("", 0, true, false)).toBe(true);
expect(canSubmitComposer("", 0, false, false)).toBe(false);
expect(canSubmitComposer("question", 0, false, false)).toBe(true);
expect(canSubmitComposer("", 1, false, false)).toBe(true);
expect(canSubmitComposer("question", 1, true, true)).toBe(false);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- src/lib/chatComposer.test.ts`

Expected: FAIL because `canSubmitComposer` is missing.

- [ ] **Step 3: Implement eligibility and render the card**

Add `canSubmitComposer(value, attachmentCount, hasSelectedContext, busy)` to
`chatComposer.ts`. Extend `ChatComposer` props with
`selectedTextContext?: SelectedPdfTextPayload | null` and
`onRemoveSelectedText?: () => void`.

Render before `.chat-composer-input`:

```tsx
{selectedTextContext && (
  <div className="composer-selected-text">
    <div className="composer-selected-text-copy">
      <strong>Page {selectedTextContext.pageNumber}:</strong>
      <span>{selectedTextContext.text}</span>
    </div>
    <button
      type="button"
      className="composer-selected-text-remove"
      aria-label="Remove selected text"
      onClick={onRemoveSelectedText}
      disabled={busy}
    >
      ×
    </button>
  </div>
)}
```

Use `canSubmitComposer` for send-button eligibility. Style the card as an inset
theme-aware surface with a compact preview, 10px radius, no shadow, a 3px accent
marker, and visible hover/focus/disabled states. Add a narrow-column rule that
keeps the close button visible and truncates the preview to two lines.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- src/lib/chatComposer.test.ts; npm run typecheck`

Expected: helper tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/lib/chatComposer.ts frontend/src/lib/chatComposer.test.ts frontend/src/components/ChatComposer.tsx frontend/src/index.css
git commit -m "feat: show selected text as composer context"
```

### Task 3: Replace immediate submission with explicit send

**Files:**
- Modify: `frontend/src/components/SelectedTextAskAi.tsx`
- Modify: `frontend/src/components/PdfViewer.tsx`
- Modify: `frontend/src/views/PaperView.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`

- [ ] **Step 1: Change the callback type from string to structured payload**

`SelectedTextAskAi.onAsk` and `PdfViewer.onAskSelectedText` become
`(context: SelectedPdfTextPayload) => void`. Clicking `Ask AI` emits
`{ text, pageNumber }` without building a message.

- [ ] **Step 2: Bind context to its source conversation**

`PaperView` stores `PendingSelectedTextContext`, replaces it on a later
selection, clears it on paper change, and passes only
`pendingContextForConversation(pending, convIdState)` into `ChatPanel`.

- [ ] **Step 3: Serialize only on explicit send**

Replace `ChatPanel.pendingPrompt` props and the auto-send effect with
`selectedTextContext` and `onRemoveSelectedText`. In `send()`:

```ts
const draft = (override ?? input).trim();
const text = selectedTextContext
  ? buildSelectedTextMessage(selectedTextContext, draft)
  : draft;
```

The empty-message guard includes the context. After `appendMessages` succeeds,
clear input, image attachments, and selected context. Provider errors and busy
state leave all three staged. Pass the structured props through to
`ChatComposer`.

- [ ] **Step 4: Verify the frontend suite**

Run: `npm run typecheck; npm test`

Expected: TypeScript exits 0 and all frontend tests pass.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/components/SelectedTextAskAi.tsx frontend/src/components/PdfViewer.tsx frontend/src/views/PaperView.tsx frontend/src/components/ChatPanel.tsx
git commit -m "feat: send selected text with a custom prompt"
```

### Task 4: Browser regression

**Files:**
- Modify: `tools/drive_ai_text_selection.py`

- [ ] **Step 1: Update the Playwright assertions**

After clicking `Ask AI`, assert `.composer-selected-text` exists and
`.msg-user` does not. Fill the textarea with
`What assumption is the author making?`, send, then assert the resulting user
message contains `Excerpt from page 1` and the custom question. Add a second
selection and remove it with `.composer-selected-text-remove`; assert the card
disappears without sending.

- [ ] **Step 2: Run the sanctioned stack and driver**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe tools/drive_ai_text_selection.py`

Expected: `AI text selection context card passed`.

- [ ] **Step 3: Commit**

```powershell
git add tools/drive_ai_text_selection.py
git commit -m "test: cover selected text composer context"
```

### Task 5: Final verification

- [ ] **Step 1: Run frontend gates**

Run: `npm run typecheck; npm test; npm run build`

Expected: all commands exit 0.

- [ ] **Step 2: Run backend gate**

Run from `backend/`: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest`

Expected: all backend tests pass.

- [ ] **Step 3: Run the Playwright regression twice**

Run the selected-text driver twice to verify idempotent E2E setup.

- [ ] **Step 4: Request independent code review**

Review conversation binding, draft preservation, removal, keyboard states, and
message serialization relative to this plan.

