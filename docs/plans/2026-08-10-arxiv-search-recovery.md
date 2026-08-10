# arXiv Search Recovery Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Make arXiv search tolerate transient rate limits and guarantee valid, continuable tool-call history after search failures.

**Architecture:** Pace and retry arXiv Atom requests in the backend, preserving persistent 429 responses. In the frontend tool loop, turn every arXiv failure into a paired tool result and continue the bounded model loop.

**Tech Stack:** FastAPI, httpx, asyncio, React/TypeScript, Vitest, pytest

---

### Task 1: Lock down backend rate-limit behavior

**Files:**
- Create: `backend/tests/test_arxiv_search.py`
- Modify: `backend/app/routers/search.py`

1. Write a failing test where arXiv returns 429 once and valid Atom XML next.
2. Run `python -m pytest backend/tests/test_arxiv_search.py -q` in `Agent_env`; expect failure because only one request is made.
3. Add a shared three-second scheduler and one retry for request errors, 429, and 5xx.
4. Add a failing test asserting persistent upstream 429 remains HTTP 429.
5. Implement 429 status fidelity with `Retry-After`; keep other non-200 failures as 502.
6. Re-run the focused backend tests; expect all pass.

### Task 2: Preserve the tool protocol and continue after failure

**Files:**
- Create: `frontend/src/lib/llm.toolRecovery.test.ts`
- Modify: `frontend/src/lib/llm.ts`

1. Mock the first model response as `search_arxiv`, make the API search reject,
   and mock the second model response as a final answer.
2. Run `npx vitest run src/lib/llm.toolRecovery.test.ts`; expect rejection and
   an assistant function call without a tool result.
3. Catch arXiv search failures, append one matching tool message to API and
   persisted histories, and let the loop continue.
4. Assert the second model request contains the matching `tool_call_id`, and
   returned messages are assistant-call, tool-result, assistant-answer.
5. Re-run the focused frontend test; expect pass.

### Task 3: Regression gates and delivery

**Files:**
- Verify all changed files.

1. Run frontend typecheck, full Vitest, and production build.
2. Run full backend pytest in `Agent_env`.
3. Run `git diff --check`, review the diff, and commit.
4. Push `codex/fix-search-recovery`, open a PR, wait for required CI, and merge.
5. Pull `main`, rebuild Docker without deleting persistent data, verify Compose
   health and HTTP 200, then exercise a real arXiv search.
6. Remove the worktree safely after removing any `frontend/node_modules`
   junction.
