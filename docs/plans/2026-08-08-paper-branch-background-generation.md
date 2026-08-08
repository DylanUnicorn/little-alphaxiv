# Paper Branch Background Generation Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Keep an LLM stream visually and operationally attached to the paper conversation branch that launched it, while showing background generation on the corresponding History node.

**Architecture:** Add a non-persisted Zustand store keyed by conversation id for in-flight UI state and abort ownership. `ChatPanel` reads and writes only the launch conversation's runtime entry, while `ConversationTree` receives the store's stable generating-id set to render an accessible progress ring.

**Tech Stack:** React 18, TypeScript, Zustand, Vitest, react-test-renderer, CSS theme tokens.

---

### Task 1: Conversation-scoped turn runtime

**Files:**
- Create: `frontend/src/store/chatRuntime.ts`
- Test: `frontend/src/store/chatRuntime.test.ts`

**Step 1: Write the failing tests**

Cover atomic start, duplicate start rejection, id-scoped patching, aborting one id without affecting another, and ignoring completion from a stale controller.

**Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/store/chatRuntime.test.ts`

Expected: FAIL because `chatRuntime.ts` does not exist.

**Step 3: Implement the minimal runtime store**

Create an in-memory Zustand store with `turns`, `generatingIds`, `start`, `patch`, `appendReasoning`, `stop`, `finish`, and a test-only reset action. Require controller identity for updates and cleanup.

**Step 4: Run the focused test and verify it passes**

Run: `npx vitest run src/store/chatRuntime.test.ts`

Expected: all runtime tests pass.

### Task 2: ChatPanel stream isolation

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx`
- Create: `frontend/src/components/chatBranchStreamIsolation.test.ts`

**Step 1: Write the failing component test**

Seed branch A as busy with partial output, render A, update the component to branch B, and assert A's partial output is absent. Update back to A and assert it is restored.

**Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/components/chatBranchStreamIsolation.test.ts`

Expected: FAIL because `ChatPanel` still owns one shared streaming state.

**Step 3: Route turn state through the runtime store**

Replace component-local `busy`, `status`, `streaming`, `reasoning`, abort ref, and send-lock ref with conversation-scoped runtime state/actions. Capture `c.id` as the launch id for every callback. Reset composer draft and attachments on `conversationId` changes.

**Step 4: Run component regressions**

Run: `npx vitest run src/components/chatBranchStreamIsolation.test.ts src/components/chatRenderPerformance.test.ts`

Expected: stream isolation passes and historical Markdown remains memoized during draft edits.

### Task 3: History node generation indicator

**Files:**
- Modify: `frontend/src/components/ConversationTree.tsx`
- Modify: `frontend/src/components/HistoryPanel.tsx`
- Modify: `frontend/src/components/ChatToolbar.tsx`
- Modify: `frontend/src/components/HistoryQuickTreePopover.tsx`
- Modify: `frontend/src/index.css`
- Create: `frontend/src/components/conversationTreeGeneration.test.ts`

**Step 1: Write the failing tree test**

Render a tree with one generating branch and assert `data-generating=true`, the `generating` class, progress-ring element, and accessible label are present only on that node.

**Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/components/conversationTreeGeneration.test.ts`

Expected: FAIL because ConversationTree has no generation-state input.

**Step 3: Implement the tree state and visuals**

Pass the stable `generatingIds` set from both History surfaces into `ConversationTree`. Render a token-based rotating outer ring and a static dashed reduced-motion alternative.

**Step 4: Run the focused tree tests**

Run: `npx vitest run src/components/conversationTreeGeneration.test.ts src/lib/conversationBranches.test.ts src/lib/historyQuickTree.test.ts`

Expected: all tests pass.

### Task 4: Full verification and delivery

**Files:**
- Modify as required by failures discovered above.

**Step 1: Run all frontend gates**

Run: `npm test`

Expected: all Vitest tests pass.

Run: `npm run typecheck`

Expected: TypeScript exits 0.

Run: `npm run build`

Expected: Vite production build exits 0.

**Step 2: Run browser verification**

Use the sanctioned local backend, frontend, and mock LLM rig. Verify branch A keeps generating after selecting B, B never displays A's partial text, A's History node shows the indicator, returning to A restores its stream, and completion persists to A.

**Step 3: Commit and open the pull request**

Commit the verified implementation, push `codex/paper-branch-stream-indicator`, open a PR, wait for frontend and backend CI, merge when green, update local `main`, and remove the worktree safely.
