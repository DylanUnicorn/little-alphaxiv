# Structured Stream Error Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Prevent main-chat SSE failures from crashing when an upstream error body or message is structured JSON instead of a string.

**Architecture:** Normalize unknown SSE error detail at the frontend API boundary before truncating it. Preserve string details verbatim, serialize objects and arrays deterministically, and fall back safely for unserializable values without changing retry or transcript behavior.

**Tech Stack:** TypeScript, Fetch/ReadableStream SSE parsing, Vitest.

---

### Task 1: Reproduce the structured-error crash

**Files:**
- Modify: `frontend/src/lib/api.streamRetry.test.ts`

**Step 1: Write the failing test**

Add a stream event whose `body` is an object and assert `streamChat` rejects with the serialized upstream detail, rather than a `.slice is not a function` `TypeError`.

**Step 2: Run the focused test to verify it fails**

Run: `npx vitest run src/lib/api.streamRetry.test.ts`

Expected: the new assertion fails with `(json.body || json.message || "").slice is not a function`.

### Task 2: Normalize unknown upstream error detail

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Step 1: Implement the minimal formatter**

Add a small formatter for `unknown` values: return strings unchanged, JSON-stringify objects/arrays and primitives, and use a safe fallback when serialization throws or returns `undefined`. Truncate only after formatting.

**Step 2: Run the focused test**

Run: `npx vitest run src/lib/api.streamRetry.test.ts`

Expected: all focused tests pass, including retry behavior and structured error rendering.

### Task 3: Verify frontend regression gates

**Files:**
- Test: `frontend/src/lib/api.streamRetry.test.ts`

**Step 1: Run typecheck**

Run: `npm run typecheck`

Expected: exit code 0.

**Step 2: Run the full frontend suite**

Run: `npm test`

Expected: all Vitest files pass.

**Step 3: Commit the implementation**

Commit the plan, test, and implementation together with a focused bug-fix message.
