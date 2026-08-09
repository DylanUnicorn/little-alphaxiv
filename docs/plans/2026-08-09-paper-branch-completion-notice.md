# Paper Branch Completion Notice Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Keep a visible History-node reminder when a paper-branch response finishes in the background, and clear it when the user views that branch.

**Architecture:** Extend the existing memory-only Zustand chat runtime with a set of completed-unviewed conversation ids. `ChatPanel` decides whether finalization happened in the background and acknowledges the selected id; both History surfaces pass the set into the existing presentational tree.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, react-test-renderer, CSS theme tokens.

---

### Task 1: Completion lifecycle in the chat runtime

**Files:**
- Modify: `frontend/src/store/chatRuntime.ts`
- Modify: `frontend/src/store/chatRuntime.test.ts`

**Step 1: Write failing lifecycle tests**

Assert that background finalization adds the conversation id, active finalization does not, acknowledgement removes it, a new turn removes an older marker, and a stale controller cannot add one.

**Step 2: Run the focused test and verify failure**

Run: `npx vitest run src/store/chatRuntime.test.ts`

Expected: FAIL because the completed-unviewed state and actions do not exist.

**Step 3: Implement the minimal store state and actions**

Add `completedIds`, extend `finishTurn` with a `notifyCompletion` boolean, add `acknowledgeCompletion`, clear the id in `startTurn`, and reset it in the test reset action.

**Step 4: Run the focused test and verify success**

Run: `npx vitest run src/store/chatRuntime.test.ts`

Expected: all runtime tests pass.

### Task 2: Active-branch acknowledgement

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/chatBranchStreamIsolation.test.ts`

**Step 1: Add a failing component assertion**

Seed a completed id, switch `ChatPanel` to that conversation, and assert the runtime no longer reports it as unviewed.

**Step 2: Run the focused test and verify failure**

Run: `npx vitest run src/components/chatBranchStreamIsolation.test.ts`

Expected: FAIL because selection does not acknowledge completion.

**Step 3: Implement acknowledgement and background detection**

Track the latest selected conversation id in a ref, acknowledge each selected id in an effect, and pass whether the launch id differs from the current id into `finishTurn`.

**Step 4: Run component regressions**

Run: `npx vitest run src/components/chatBranchStreamIsolation.test.ts src/components/chatRenderPerformance.test.ts`

Expected: completion acknowledgement and prior stream-isolation/render tests pass.

### Task 3: History completion badge

**Files:**
- Modify: `frontend/src/components/ConversationTree.tsx`
- Modify: `frontend/src/components/HistoryPanel.tsx`
- Modify: `frontend/src/components/ChatToolbar.tsx`
- Modify: `frontend/src/components/HistoryQuickTreePopover.tsx`
- Modify: `frontend/src/components/conversationTreeGeneration.test.ts`
- Modify: `frontend/src/index.css`

**Step 1: Add failing tree assertions**

Assert that only a completed-unviewed node gets the completion class, `data-completed`, static badge, and accessible label; assert generating state takes precedence if both inputs contain an id.

**Step 2: Run focused tree tests and verify failure**

Run: `npx vitest run src/components/conversationTreeGeneration.test.ts`

Expected: FAIL because the tree has no completion input or badge.

**Step 3: Pass and render the completion state**

Subscribe in both History surfaces, pass `completedIds` through the quick popover, render a static badge using existing theme tokens, and preserve the current spinner/reduced-motion behavior.

**Step 4: Run focused tree regressions**

Run: `npx vitest run src/components/conversationTreeGeneration.test.ts src/lib/conversationBranches.test.ts src/lib/historyQuickTree.test.ts`

Expected: all tree tests pass.

### Task 4: Full verification and delivery

**Files:**
- Modify only files required by failures found above.

**Step 1: Run all frontend gates**

Run: `npm test`, then `npm run typecheck`, then `npm run build` from `frontend/`.

Expected: all tests, TypeScript, and production build pass.

**Step 2: Verify the visible browser flow**

Start the sanctioned backend, frontend, and mock LLM; generate in one paper branch, switch away, wait for completion, and open the marked branch.

Expected: spinner becomes a static completion badge on the background branch, the active branch remains clean, and opening the completed branch clears the badge with no console errors.

**Step 3: Commit and open a pull request**

Commit only the design, plan, runtime, components, CSS, and tests for this feature. Push `codex/branch-completion-notice`, open a PR, wait for frontend and backend CI, then merge only when both pass.
