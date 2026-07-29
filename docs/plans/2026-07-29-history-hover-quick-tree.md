# History Hover Quick Tree Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Add a tree-only hover popover to the paper-view History button for one-click branch navigation while preserving the existing full History panel on click.

**Architecture:** Derive the active History in `ChatToolbar`, render it through a portal anchored to the History button, and reuse `ConversationTree` with a compact presentation mode. Keep navigation owned by `PaperView`, and keep all deletion and root-management actions exclusive to `HistoryPanel`.

**Tech Stack:** React 18, TypeScript, Zustand, CSS theme tokens, Vitest, Playwright.

---

### Task 1: Test quick-popover geometry

**Files:**
- Create: `frontend/src/lib/historyQuickTree.ts`
- Create: `frontend/src/lib/historyQuickTree.test.ts`

**Steps:**
1. Write tests for compact width, left-edge clamping, right-edge clamping, and below-toolbar placement.
2. Run `npx vitest run src/lib/historyQuickTree.test.ts` and confirm the missing helper fails.
3. Implement deterministic geometry helpers with no DOM dependency.
4. Re-run the focused test and confirm it passes.

### Task 2: Add compact tree presentation

**Files:**
- Modify: `frontend/src/components/ConversationTree.tsx`
- Modify: `frontend/src/index.css`

**Steps:**
1. Add an optional `compact` prop that retains nodes, connectors, focus, current highlight, and navigation.
2. Omit the detail footer, delete affordance, and visible title tooltip in compact mode.
3. Add theme-token styles for the compact canvas, scroll bounds, focus state, and reduced motion.
4. Run TypeScript and the conversation-tree helper tests.

### Task 3: Build the anchored hover popover

**Files:**
- Create: `frontend/src/components/HistoryQuickTreePopover.tsx`
- Modify: `frontend/src/components/ChatToolbar.tsx`
- Modify: `frontend/src/views/PaperView.tsx`
- Modify: `frontend/src/index.css`

**Steps:**
1. Derive the active History from paper conversations and pass only its nodes to the quick popover.
2. Open on History-button hover, cancel closing while the popover is hovered, and close after a short pointer-leave delay.
3. Close the quick popover on node selection, full-panel click, route/active-node changes, Escape, resize, and unmount.
4. Pass PaperView's existing conversation-selection callback through the toolbar so navigation remains centralized.
5. Confirm click/touch behavior still opens the full History panel.

### Task 4: Extend end-to-end regression

**Files:**
- Modify: `tools/drive_conversation_branches.py`

**Steps:**
1. Hover History on a single-root paper conversation and assert a one-node tree-only popover.
2. Create a branch, hover again, and assert the child is current and no details or delete controls exist.
3. Click the root node and assert immediate paper-route navigation.
4. Click History and assert the existing full panel still includes management details and deletion.
5. Capture a dark-theme screenshot of the quick tree.

### Task 5: Full gates and delivery

**Files:**
- Modify as needed based on failures.

**Steps:**
1. Run `npm run typecheck` and `npm test` in `frontend/`.
2. Run backend `python -m pytest` with `Agent_env`.
3. Run the isolated Playwright branch driver.
4. Review `git diff --check`, commit, push, open a PR, and wait for both CI jobs.
5. Merge, sync `main`, remove the worktree safely, rebuild Docker, and verify `/api/health` returns 200.
