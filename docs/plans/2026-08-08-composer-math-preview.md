# Composer Math Preview Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Show a readable Markdown/KaTeX preview for formula-containing drafts without changing textarea editing or historical-message performance.

**Architecture:** Add a code-aware math-syntax predicate to the existing math Markdown utility. In `ChatComposer`, derive a deferred draft, conditionally render the shared Markdown component below the textarea, and style the preview with existing theme tokens and bounded overflow.

**Tech Stack:** React 18, TypeScript, ReactMarkdown, remark-math, rehype-katex, Vitest, react-test-renderer, CSS tokens.

---

### Task 1: Detect renderable draft math

**Files:**
- Modify: `frontend/src/lib/mathMarkdown.ts`
- Modify: `frontend/src/lib/mathMarkdown.test.ts`

1. Add failing cases for closed inline/display delimiters, multiline display math, escaped delimiters, incomplete math, and code spans/blocks.
2. Run the focused test and confirm the exported predicate is missing.
3. Implement detection on non-code segments after normalizing `\(...\)`, `\[...\]`, and loose `$$content$$` display delimiters.
4. Re-run the focused test.

### Task 2: Render the deferred composer preview

**Files:**
- Modify: `frontend/src/components/ChatComposer.tsx`
- Create: `frontend/src/components/chatComposerMathPreview.test.ts`
- Modify: `frontend/src/components/chatRenderPerformance.test.ts`

1. Add a failing component test that a formula draft renders a labeled preview through `Markdown` and ordinary prose does not.
2. Extend the historical-render test so a draft formula adds only the preview render while the completed rows retain their counts.
3. Import `useDeferredValue`, the predicate, and `Markdown`; render a read-only preview with paper-link enrichment disabled.
4. Re-run focused tests.

### Task 3: Add bounded theme-aware layout

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/markdown-layout.test.ts`

1. Add failing stylesheet assertions for bounded vertical overflow and horizontal display-math overflow.
2. Add compact preview styles using existing `--bg-*`, `--border`, `--text`, and `--accent` tokens.
3. Re-run the layout test.

### Task 4: Verify and ship

1. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
2. Paste the reported multiline formula in the authenticated local app and verify KaTeX is visible before send.
3. Commit, push, open a PR, wait for frontend/backend CI, and merge.
4. Fast-forward local `main`, safely remove the worktree and branch, rebuild Docker without removing orphans, and verify `/api/health` returns 200.
