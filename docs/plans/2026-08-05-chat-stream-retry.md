# Chat Stream Retry Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Keep general chat usable when an OpenAI-compatible upstream intermittently drops the TLS connection before the first SSE byte.

**Architecture:** Add a bounded retry at the backend streaming boundary. Retry only transient `httpx.RequestError` failures that occur before any upstream bytes have been forwarded; once output begins, preserve at-most-once delivery and surface the failure without replaying the request.

**Tech Stack:** FastAPI, httpx async streaming, pytest, React/Vitest regression gates.

---

### Task 1: Streaming retry contract

**Files:**
- Modify: `backend/tests/test_llm_responses.py`
- Modify: `backend/app/routers/llm.py`

1. Add a failing test where the first stream attempt raises `httpx.ConnectError` before output and the second emits a valid Responses stream.
2. Add a failing test where all attempts fail and assert the SSE error contains a useful exception class/message without secrets.
3. Add a failing test where one byte/event has been emitted before failure and assert the request is not retried.
4. Run the focused tests and confirm they fail for the expected missing retry behavior.
5. Implement a two-attempt loop with a short backoff, explicit attempt logging, and a `sent_upstream_bytes` guard.
6. Run the focused tests and confirm they pass.

### Task 2: Regression and delivery

**Files:**
- Verify: `backend/tests/`
- Verify: `frontend/src/`

1. Run the complete backend pytest suite in `Agent_env`.
2. Run frontend `npm run typecheck` and `npm test`.
3. Commit and push `codex/chat-stream-retry`.
4. Open a PR, wait for required CI checks, and merge it.
5. Pull `main`, rebuild from `deploy/`, verify `docker compose ps` and `/api/health` returns 200.
6. Exercise the real main-chat request and confirm the transient first-attempt failure is recovered without duplicate output.
