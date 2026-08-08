# Rendered Math Copy Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task with TDD.

**Goal:** Preserve canonical Markdown/LaTeX when users copy rendered formulas from chat history and paste them into the visual composer.

**Architecture:** Add a DOM-selection serializer dedicated to KaTeX output. Attach it to the chat-history copy boundary so the existing composer parser receives normal `$...$` or `$$...$$` Markdown without adding heuristic LaTeX detection.

**Tech Stack:** React 18, TypeScript, KaTeX DOM, Tiptap, Vitest/jsdom.

---

### Task 1: Specify rendered-selection serialization

**Files:**
- Create: `frontend/src/lib/renderedMathClipboard.test.ts`
- Create: `frontend/src/lib/renderedMathClipboard.ts`

1. Write failing tests for mixed prose plus inline/display KaTeX, multiple equations, plain text, and absent TeX annotations.
2. Run `npx vitest run src/lib/renderedMathClipboard.test.ts` and confirm failure because the serializer is absent.
3. Implement a minimal selection-clone serializer that replaces recoverable KaTeX roots with delimited annotation TeX.
4. Re-run the focused test and expect all cases to pass.

### Task 2: Connect chat copy to the serializer

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/chatComposerMathEditor.test.tsx`

1. Add a failing integration test proving canonical copied Markdown creates editable formula nodes through the existing paste path.
2. Add a chat-history `onCopy` handler that calls the serializer and only prevents the browser default after a successful conversion.
3. Run the focused component and clipboard tests.

### Task 3: Regression and browser verification

**Files:**
- No production-file additions expected.

1. Run `npm run typecheck`.
2. Run `npm test`.
3. Run `npm run build` and `git diff --check`.
4. In the browser, copy mixed prose and formulas from a rendered assistant response, paste into the composer, confirm visual editable formula nodes, and verify the serialized draft contains canonical delimiters.
5. Commit, push, open a PR, wait for both CI jobs, merge, rebuild Docker, and verify `/api/health` returns HTTP 200.

