# Responses API Provider Support Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Let a configured provider use either OpenAI Chat Completions or the OpenAI-compatible Responses API without changing the rest of the chat experience.

**Architecture:** Persist an explicit `api_format` on every provider, defaulting to `chat_completions` for existing rows. The backend adapts the application's Chat Completions-shaped payload and SSE stream to/from the Responses API, so the frontend conversation and tool loop stay unchanged. The settings page exposes the choice when adding and reviewing a provider.

**Tech Stack:** FastAPI, SQLModel/Alembic, httpx, React, TypeScript, Vitest, pytest.

---

### Task 1: Persist and expose the provider API format

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/app/routers/providers.py`
- Create: `backend/alembic/versions/<revision>_add_provider_api_format.py`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/lib/api.ts`

**Step 1: Write the failing test**

Add a provider-router test that creates a provider with `api_format: "responses"` and asserts it is returned unchanged; assert omitted input returns `chat_completions`.

**Step 2: Run test to verify it fails**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest backend/tests/test_llm_responses.py -v`

Expected: FAIL because provider schemas and database model do not expose `api_format`.

**Step 3: Write minimal implementation**

Add the validated format field with a safe default to the SQLModel and API schemas; add an additive Alembic migration with the same server default.

**Step 4: Run test to verify it passes**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest backend/tests/test_llm_responses.py -v`

Expected: PASS.

### Task 2: Adapt Responses requests and non-streaming responses

**Files:**
- Modify: `backend/app/routers/llm.py`
- Test: `backend/tests/test_llm_responses.py`

**Step 1: Write the failing test**

Add an httpx mock test for a `responses` provider. Assert the backend posts to `/responses`, converts messages and function tools to Responses `input` and tool objects, and turns an upstream output message/function call into the existing Chat Completions result shape.

**Step 2: Run test to verify it fails**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest backend/tests/test_llm_responses.py -v`

Expected: FAIL because the proxy posts to `/chat/completions` and forwards a Chat Completions body verbatim.

**Step 3: Write minimal implementation**

Add narrow conversion helpers for request messages, tools, assistant calls, tool outputs, and non-streaming response output. Preserve the existing passthrough path for Chat Completions providers.

**Step 4: Run test to verify it passes**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest backend/tests/test_llm_responses.py -v`

Expected: PASS.

### Task 3: Adapt Responses streaming to existing SSE consumers

**Files:**
- Modify: `backend/app/routers/llm.py`
- Test: `backend/tests/test_llm_responses.py`

**Step 1: Write the failing test**

Add a streamed Responses fixture containing text deltas, function-call argument deltas, completion usage, and `response.completed`; assert the proxy emits equivalent Chat Completions SSE chunks plus `[DONE]`.

**Step 2: Run test to verify it fails**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest backend/tests/test_llm_responses.py -v`

Expected: FAIL because Responses events are currently forwarded verbatim.

**Step 3: Write minimal implementation**

Translate supported Responses SSE event types into the Chat Completions delta structure consumed by `parseSSE`, retaining existing stream error behavior.

**Step 4: Run test to verify it passes**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest backend/tests/test_llm_responses.py -v`

Expected: PASS.

### Task 4: Surface the format in Settings and verify regressions

**Files:**
- Modify: `frontend/src/views/SettingsView.tsx`
- Modify: `frontend/src/types.ts`
- Test: `frontend/src/lib/api.ts` (compile coverage)

**Step 1: Write the failing test**

Use the provider API typings in a TypeScript build with `api_format: "responses"` so the type gate fails before the field is added.

**Step 2: Run test to verify it fails**

Run: `npm run typecheck`

Expected: FAIL before the UI/type change when referencing `api_format`.

**Step 3: Write minimal implementation**

Add a selector to the provider form, label existing provider cards with their format, and pass the field through store/API CRUD. Keep `chat_completions` the default.

**Step 4: Run test to verify it passes**

Run: `npm run typecheck && npm test`

Expected: PASS.

### Task 5: Complete quality gates and handoff

**Files:**
- Modify: relevant implementation and tests only

**Step 1: Run backend suite**

Run: `C:\Users\Delig\.conda\envs\Agent_env\python.exe -m pytest`

Expected: PASS.

**Step 2: Run frontend suite**

Run: `npm run typecheck && npm test`

Expected: PASS.

**Step 3: Commit and submit**

Commit the scoped implementation, push `codex/responses-api`, create a pull request, wait for CI, then merge according to repository workflow.
