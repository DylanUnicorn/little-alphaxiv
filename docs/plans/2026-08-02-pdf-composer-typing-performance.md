# PDF Composer Typing Performance Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Make typing and deleting in the PDF preview chat composer remain smooth even with a long, richly rendered conversation.

**Architecture:** Preserve the controlled `ChatComposer`, but keep draft-only updates from invalidating memoized history rows. Stabilize the branch action callback and memoize completed agent-activity groups so expensive Markdown and KaTeX history does not re-render per keystroke.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, Vite, Docker Compose.

---

### Task 1: Capture the regression

**Files:**
- Test: `frontend/src/components/chatRenderPerformance.test.tsx`

1. Add a focused test harness that re-renders a parent with a changed draft.
2. Assert the historical row's render counter stays unchanged.
3. Run the focused test and confirm it fails against the current unstable callback.

### Task 2: Restore the render boundary

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/AgentActivity.tsx`

1. Wrap the paper-branch handler in `useCallback` with semantic dependencies.
2. Memoize `AgentActivity` so completed activity groups are stable during draft edits.
3. Run the focused test and confirm it passes.

### Task 3: Verify and ship

**Files:**
- Verify all changed files.

1. Run frontend typecheck, full Vitest, production build, and `git diff --check`.
2. Commit and push the task branch, open a PR, wait for required CI, and merge.
3. Pull merged `main`, rebuild with `docker compose up -d --build` from `deploy`, then verify `docker compose ps` and HTTP 200 from `/api/health`.
