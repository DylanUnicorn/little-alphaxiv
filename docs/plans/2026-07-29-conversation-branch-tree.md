# Conversation Branch Tree Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Add persistent, navigable conversation branches created from selected assistant text without changing the parent branch.

**Architecture:** Keep every tree node as a complete existing `Conversation`, copy the message prefix at branch time, and add immutable lineage metadata. Group conversations into History trees in pure frontend helpers, render them with an accessible SVG-backed node graph, and let the backend validate lineage and delete subtrees atomically.

**Tech Stack:** FastAPI, SQLModel, Alembic, SQLite, React 18, TypeScript, Zustand, CSS theme tokens, Vitest, pytest, Playwright.

---

### Task 1: Define and test branch semantics

**Files:**
- Create: `frontend/src/lib/conversationBranches.ts`
- Create: `frontend/src/lib/conversationBranches.test.ts`
- Modify: `frontend/src/types.ts`

**Steps:**
1. Write failing tests for root fallback, History grouping, selected-message prefix cloning, pending branch context, descendant collection, deterministic tree layout, and 2,000-character excerpt normalization.
2. Run `npm test -- --run frontend/src/lib/conversationBranches.test.ts` and confirm the module is missing.
3. Add lineage fields to `Conversation` and implement the tested pure helpers without UI dependencies.
4. Run the focused test and confirm it passes.

### Task 2: Persist and validate lineage

**Files:**
- Create: `backend/alembic/versions/0006_conversation_branching.py`
- Create: `backend/tests/test_conversations.py`
- Modify: `backend/app/models.py`
- Modify: `backend/app/routers/conversations.py`

**Steps:**
1. Write API tests that create a root and child, reject invalid message indexes and cross-user parents, reject changed lineage, and delete a child subtree.
2. Run `conda activate Agent_env; python -m pytest backend/tests/test_conversations.py -q` and confirm the new fields are rejected or absent.
3. Add the four columns and indexes, serialize them in summary/full responses, validate new child rows, and return `deleted_ids` from recursive deletion.
4. Re-run the focused backend tests and migration upgrade/downgrade checks.

### Task 3: Add store operations

**Files:**
- Create: `frontend/src/store/conversationBranching.test.ts`
- Modify: `frontend/src/store/conversations.ts`
- Modify: `frontend/src/lib/api.ts`

**Steps:**
1. Mock the API and write failing store tests for branch persistence, inherited settings, state integrity on save failure, and returned subtree IDs on deletion.
2. Add `branchFromMessage`, assign root lineage during normal creation, and consume `deleted_ids` in `remove`.
3. Run the focused store tests and the existing conversation-store suite.

### Task 4: Create the selection affordance

**Files:**
- Create: `frontend/src/components/AssistantBranchAction.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/ChatComposer.tsx`
- Modify: `frontend/src/lib/selectedTextAskAi.ts`
- Modify: `frontend/src/index.css`

**Steps:**
1. Add pure tests for building an assistant-excerpt prompt and limiting selections to one assistant message.
2. Render a portal-based `Branch` button beside a valid selection and dismiss it on outside pointer, scroll, Escape, busy state, or route change.
3. On click, persist the child and navigate by conversation type. Derive the pending excerpt from lineage and display it above the composer until the first branch question is sent.
4. Verify keyboard focus, accessible labels, theme tokens, and reduced motion.

### Task 5: Build grouped History trees

**Files:**
- Create: `frontend/src/components/ConversationTree.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/HistoryPanel.tsx`
- Modify: `frontend/src/index.css`

**Steps:**
1. Render the deterministic layout with SVG connections and button nodes; highlight the active node with a filled accent circle and restrained glow.
2. Group general sidebar rows by History root and make row activation open the most-recent node while the tree opens on hover, focus, or touch-tree-button.
3. Group paper conversations by root in the paper History panel and reuse the same tree.
4. Add confirmation copy for deleting a branch subtree or entire History and verify the root cannot be deleted from inside its tree.

### Task 6: End-to-end verification

**Files:**
- Create: `tools/drive_conversation_branches.py`

**Steps:**
1. Seed a persisted conversation through the authenticated API, select assistant text in the rendered Markdown, click `Branch`, and assert the child route and composer excerpt.
2. Send a branch-only question against the mock LLM and assert the parent stayed unchanged.
3. Hover the History row, assert two nodes and active highlight, navigate to the root, then delete the child subtree with confirmation.
4. Capture dark and light theme screenshots and visually inspect node paths, labels, clipping, focus, and contrast.

### Task 7: Full gates and delivery

**Files:**
- Modify as needed based on failures.

**Steps:**
1. Run `npm run typecheck` and `npm test` in `frontend/`.
2. Run `conda activate Agent_env; python -m pytest` in `backend/`.
3. Run the Playwright branch driver with the backend, frontend, and mock LLM.
4. Review `git diff`, commit, push `codex/conversation-branch-tree`, open a PR, wait for both CI jobs, and merge only after green.
5. Pull `main`, remove the worktree safely after removing its `frontend/node_modules` junction, and report verified outputs.
