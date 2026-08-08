# User Message Markdown And Copy Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Render sent user Markdown/LaTeX and preserve original Markdown when rendered assistant content is copied back into the composer.

**Architecture:** Reuse the existing shared `Markdown` component for user content, with assistant-only link-card enrichment disabled for user messages. Load KaTeX's official `copy-tex` browser extension once at app startup so selections containing rendered formulas serialize to TeX delimiters instead of duplicated MathML/HTML text.

**Tech Stack:** React 18, TypeScript, ReactMarkdown, remark-math, rehype-katex, Vitest, react-test-renderer, jsdom.

---

### Task 1: Lock user Markdown rendering behavior

**Files:**
- Modify: `frontend/src/components/chatRenderPerformance.test.ts`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/Markdown.tsx`

1. Add a user Markdown message to the fixture and assert the shared renderer receives both user and assistant source.
2. Run the focused test and confirm it fails because only assistant content is rendered.
3. Render user content through `Markdown` while keeping attachments unchanged and disabling assistant-only paper-card enrichment.
4. Re-run the focused test and confirm draft edits do not rerender either historical message.

### Task 2: Preserve Markdown in copied plain text

**Files:**
- Create: `frontend/src/markdown-copy-integration.test.ts`
- Modify: `frontend/src/main.tsx`

1. Add an integration test asserting the app entry imports KaTeX's official copy extension after the core KaTeX stylesheet.
2. Run the focused test and confirm it fails before the integration exists.
3. Import `katex/contrib/copy-tex` once in `main.tsx`.
4. In jsdom, select inside a rendered formula and assert `copy` emits one TeX source with delimiters; assert prose copy is untouched.
5. Re-run the focused test and confirm the integration is locked in.

### Task 3: Preserve layout and accessibility

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/markdown-layout.test.ts`

1. Add regression assertions that user Markdown inherits compact bubble spacing and math overflow behavior.
2. Add minimal `.msg-user` Markdown selectors using existing tokens and dimensions.
3. Confirm links remain keyboard accessible and displayed formulas scroll horizontally inside narrow user bubbles.

### Task 4: Verify and ship

**Files:**
- All changed files above

1. Run focused Vitest files.
2. Run `npm run typecheck`, `npm test`, and `npm run build` from `frontend/`.
3. Run `git diff --check`.
4. Verify the visible send, render, copy, and paste flow in the browser.
5. Commit, push, open a PR, wait for both CI jobs, merge, update local `main`, and remove the worktree safely.
