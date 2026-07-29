# Ask AI Context Visibility Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Ensure the floating PDF `Ask AI` button remains clickable while zoomed panning is enabled.

**Architecture:** Move the PDF panning target predicate into a small pure helper and classify the floating `Ask AI` button as an interactive child. Keep the selection, conversation, and composer data flow unchanged.

**Tech Stack:** React 18, TypeScript, Vitest, Playwright Python driver.

---

### Task 1: Add the failing panning-exemption tests

**Files:**
- Create: `frontend/src/lib/pdfPointerInteraction.ts`
- Create: `frontend/src/lib/pdfPointerInteraction.test.ts`

1. Add tests asserting PDF text and annotation controls keep their pointer
   interactions, the floating `Ask AI` button also keeps its pointer
   interaction, and blank page content remains pannable.
2. Run `npx vitest run src/lib/pdfPointerInteraction.test.ts`. Expect the
   `Ask AI` case to fail before the selector is added.

### Task 2: Exempt Ask AI from zoomed PDF panning

**Files:**
- Modify: `frontend/src/components/PdfViewer.tsx`
- Modify: `frontend/src/lib/pdfPointerInteraction.ts`

1. Move the existing `shouldKeepPdfPointerInteraction` predicate out of
   `PdfViewer` into the tested helper module without changing its current
   input, text-layer, or annotation behavior.
2. Add `.selected-text-ask-ai` to the interactive target selectors.
3. Import the helper in `PdfViewer` and remove the local copy.
4. Re-run the focused unit test and expect all cases to pass.

### Task 3: Add the 160% browser regression

**Files:**
- Modify: `tools/drive.py`
- Modify: `tools/drive_ai_text_selection.py`

1. Allow the shared driver to read app, backend, and mock URLs from optional
   environment variables so an isolated native backend can run beside Docker.
2. Zoom the PDF from 100% to 160% before selecting page-one text.
3. Click `Ask AI` and assert the floating button disappears, the composer card
   appears, and no user message is submitted before explicit Send.
4. Run the driver against the local backend, frontend, and mock LLM in
   `Agent_env`; expect the selection context flow to pass.

### Task 4: Run repository gates

**Files:** none.

1. Run `npm run typecheck` in `frontend/` and expect zero TypeScript errors.
2. Run `npm test` in `frontend/` and expect all Vitest tests to pass.
3. Run the 160% selected-text Playwright driver in `Agent_env` and expect
   `AI text selection context card passed`.
4. Run `git diff --check` and inspect the final diff.

### Task 5: Deliver through the repository workflow

1. Commit the design, plan, regression, and implementation on
   `codex/fix-ask-ai-context`.
2. Push the branch and open a pull request against `main`.
3. Wait for frontend and backend CI checks to pass, then merge.
4. Pull `main`, remove the worktree's private `frontend/node_modules` safely,
   and remove the worktree.
