# Paper Default Provider Sync Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Ensure an unstarted paper chat adopts the newly selected default provider when it is reused without a browser refresh.

**Architecture:** Empty conversations are intentionally held only in the client until their first message. The conversation store owns empty-conversation reuse for both general and paper chats, so it will replace the reused empty conversation's provider id with the caller's current default. Persisted conversations and their explicit provider selection remain unchanged.

**Tech Stack:** React, TypeScript, Zustand, Vitest.

---

### Task 1: Specify the empty-thread provider refresh

**Files:**
- Modify: `frontend/src/store/conversations.test.ts`

**Step 1: Write the failing test**

Create an empty paper conversation using provider A, then call `create` again with `reuseEmpty: true` and provider B. Assert that the same conversation id is returned and its `provider_id` becomes B.

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/conversations.test.ts`

Expected: FAIL because reusing the empty conversation retains provider A.

### Task 2: Refresh provider when an empty conversation is reused

**Files:**
- Modify: `frontend/src/store/conversations.ts`

**Step 1: Implement the minimal code**

When `create({ reuseEmpty: true, providerId })` finds a reusable empty conversation, set its `provider_id` to the supplied provider id along with the existing recency update.

**Step 2: Run the focused test**

Run: `npx vitest run src/store/conversations.test.ts`

Expected: PASS.

### Task 3: Verify the frontend gate

**Files:**
- Verify: `frontend/src/store/conversations.test.ts`

**Step 1: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

**Step 2: Run all frontend tests**

Run: `npm test`

Expected: all tests pass.
