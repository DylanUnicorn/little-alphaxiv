# Chat Stream Reconnect Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Recover one transient chat-stream connection failure before output begins and render a terminal failure only once.

**Architecture:** Keep the backend's existing pre-byte retry and add one bounded frontend reconnect in `streamChat`. Track semantic SSE progress and retry only typed connection failures before progress; expose reconnect state through the existing status callback and preserve partial-response safety.

**Tech Stack:** TypeScript, Fetch/ReadableStream SSE, React, Vitest, Python/FastAPI regression tests.

---

### Task 1: Specify safe reconnect behavior

**Files:**
- Create: `frontend/src/lib/api.streamRetry.test.ts`
- Modify: `frontend/src/lib/api.ts`

**Step 1:** Add failing tests using scripted `fetch` responses for: first request proxy `ConnectError` then success; connection failure after a content delta; aborted request; and two consecutive pre-progress failures.

**Step 2:** Run `npx vitest run src/lib/api.streamRetry.test.ts` and confirm the reconnect test fails because `streamChat` performs one request.

**Step 3:** Add a typed `ChatStreamError`, semantic-progress tracking, one reconnect attempt, abort-aware backoff, and an optional `onReconnect` callback. Do not retry HTTP status errors, provider validation errors, aborts, or streams with content/reasoning/tool progress.

**Step 4:** Re-run the focused test and confirm all cases pass.

### Task 2: Surface reconnect state and remove duplicate terminal errors

**Files:**
- Modify: `frontend/src/lib/llm.ts`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Create or modify: a focused frontend test for the extracted error-message builder

**Step 1:** Add a failing test that an empty response buffer yields a single assistant error representation while a partial response retains content plus interruption metadata.

**Step 2:** Thread `onReconnect` from `streamChat` to `runConversation`'s existing `onStatus` callback and display `Reconnecting…`.

**Step 3:** Extract or introduce the smallest pure helper needed so the catch path does not store identical text in both `content` and `ui.error` when the buffer is empty.

**Step 4:** Run the focused tests and confirm reconnect status and error-shape assertions pass.

### Task 3: Regression verification

**Files:**
- Test: `frontend/src/lib/api.streamRetry.test.ts`
- Test: `backend/tests/test_llm_responses.py`

**Step 1:** Run `npm run typecheck`.

**Step 2:** Run `npm test` and record the exact pass count.

**Step 3:** Activate `Agent_env` and run `python -m pytest tests/test_llm_responses.py`, recording the exact result.

**Step 4:** Inspect `git diff --check` and `git status --short`, then commit the scoped changes.

### Task 4: Publish through the protected-main workflow

**Files:**
- No source changes.

**Step 1:** Push `codex/chat-reconnect` to `origin` without force.

**Step 2:** Open a PR describing the safe replay boundary and test evidence.

**Step 3:** Wait for frontend and backend CI to pass before merging.

**Step 4:** Merge the PR, update local `main`, rebuild the Docker deployment, and verify container health plus `/api/health` HTTP 200 without touching `deploy/data/`.
