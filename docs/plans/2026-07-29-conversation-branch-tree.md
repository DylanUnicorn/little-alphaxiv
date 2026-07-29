# Conversation Branch Tree Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Keep persistent conversation branches exclusively inside paper-preview sub-conversations while restoring general chat to a flat, branch-free experience.

**Architecture:** Keep the existing lineage model and tree implementation for `paper` conversations, but gate branch creation on conversation type at both frontend and backend. Render trees only inside the paper view's History panel; render general conversations as the original one-row-per-conversation sidebar list.

**Tech Stack:** FastAPI, SQLModel, Alembic, SQLite, React 18, TypeScript, Zustand, CSS theme tokens, Vitest, pytest, Playwright.

---

### Corrective Task 1: Enforce paper-only lineage

**Files:**
- Modify: `backend/app/routers/conversations.py`
- Modify: `backend/tests/test_conversations.py`

**Steps:**
1. Convert valid branch fixtures to paper conversations with a stable `paper_id`.
2. Add a regression proving a `general` parent cannot create a child branch.
3. Reject non-paper parents before accepting branch lineage.
4. Run focused backend tests.

### Corrective Task 2: Remove general-chat branch UI

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/ConversationTree.tsx`
- Modify: `frontend/src/index.css`

**Steps:**
1. Render `AssistantBranchAction` only when the active conversation type is `paper`.
2. Restore general sidebar rows to one row per conversation with no History grouping or tree button.
3. Remove the now-unused sidebar tree popover code and styles.
4. Keep the inline `ConversationTree` used by the paper History panel unchanged.

### Corrective Task 3: Move E2E coverage to paper preview

**Files:**
- Modify: `tools/drive_conversation_branches.py`

**Steps:**
1. Seed both a general conversation and a paper conversation.
2. Select assistant text in general chat and assert no branch affordance appears.
3. Open the paper preview, create a branch from its assistant reply, and assert the paper route and inherited prefix.
4. Open the paper History panel, verify three-node layout, navigate, delete branches, and capture dark/light screenshots.

### Corrective Task 4: Normalize legacy general-chat lineage

**Files:**
- Create: `backend/alembic/versions/0007_flatten_general_conversations.py`
- Create: `backend/tests/test_migrations.py`

**Steps:**
1. Seed legacy branched `general` rows and valid branched `paper` rows at revision `0006`.
2. Upgrade to `0007` and assert each general row becomes an independent root without changing its messages.
3. Assert every paper lineage field remains unchanged.
4. Downgrade to `0006`, upgrade again, and assert the safe flattened shape is stable.

### Corrective Task 5: Full gates and delivery

**Files:**
- Modify as needed based on failures.

**Steps:**
1. Run `npm run typecheck` and `npm test` in `frontend/`.
2. Run `conda activate Agent_env; python -m pytest` in `backend/`.
3. Run the paper-only Playwright branch driver with isolated backend, frontend, and mock LLM.
4. Review `git diff`, commit, push `codex/paper-only-conversation-branches`, open a PR, wait for both CI jobs, and merge only after green.
5. Pull `main`, remove the worktree junction safely, rebuild Docker, and verify `/api/health` returns 200.
