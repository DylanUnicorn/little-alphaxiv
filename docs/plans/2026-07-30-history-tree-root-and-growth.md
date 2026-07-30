# History Tree Root And Growth Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Give the paper-chat History tree an unmistakable root marker and an animated parent-to-child reveal when a new branch is created.

**Architecture:** Keep the existing top-down layout and add semantic root/new-node state to `ConversationTree`. Detect newly inserted branch conversations in `ChatToolbar`, auto-open the existing portal popover, and pass the new node id down so SVG and node animations remain local to the tree renderer.

**Tech Stack:** React 18, TypeScript, Zustand, CSS/SVG animations, Vitest, Playwright.

---

### Task 1: Define new-branch detection

**Files:**
- Create: `frontend/src/lib/historyBranchReveal.ts`
- Create: `frontend/src/lib/historyBranchReveal.test.ts`

**Steps:**
1. Write tests for initial hydration, a newly added child, an existing node, and unrelated History nodes.
2. Run the focused Vitest file and confirm it fails before implementation.
3. Implement a pure helper that returns branch ids absent from the prior known-id set.
4. Re-run the focused test and confirm it passes.

### Task 2: Add root and growth semantics

**Files:**
- Modify: `frontend/src/components/ConversationTree.tsx`
- Modify: `frontend/src/index.css`

**Steps:**
1. Add an optional `revealedNodeId` prop.
2. Mark the root button with a root class, `data-root`, and a decorative marker span.
3. Mark the matching child edge and node as newly revealed.
4. Add a root foundation ring and downward stem using current theme tokens.
5. Add edge-draw, node-arrival, and one-shot pulse animations using transform, opacity, and SVG stroke offset.
6. Disable all creation motion under `prefers-reduced-motion`.

### Task 3: Auto-reveal a newly created branch

**Files:**
- Modify: `frontend/src/components/ChatToolbar.tsx`
- Modify: `frontend/src/components/HistoryQuickTreePopover.tsx`

**Steps:**
1. Track known paper-conversation ids after initial hydration.
2. Hold newly inserted branch ids until one becomes the active route conversation.
3. Auto-open the quick tree and pass the active new id to the tree.
4. Close the acknowledgement after a short delay unless hover takes ownership.
5. Clear pending state on paper changes, manual close, full History open, and unmount.

### Task 4: Extend browser regression

**Files:**
- Modify: `tools/drive_conversation_branches.py`

**Steps:**
1. Assert one root marker and top-to-bottom parent/child geometry.
2. Create a branch and assert the quick tree opens without hover.
3. Assert the new edge and node carry active animation names in normal-motion mode.
4. Confirm hover keeps the popover open and navigation remains immediate.
5. Add a reduced-motion context check with the same final geometry and no animation.
6. Capture dark and light screenshots.

### Task 5: Quality gates and delivery

**Files:**
- Modify as needed based on failures.

**Steps:**
1. Run `npm run typecheck` and full `npm test`.
2. Run backend `python -m pytest` in `Agent_env`.
3. Run the isolated Playwright branch driver and inspect screenshots.
4. Review the diff and run `git diff --check`.
5. Commit, push, open a PR, wait for CI, and merge.
6. Sync `main`, remove the worktree safely, rebuild Docker, and verify `/api/health` returns 200.
