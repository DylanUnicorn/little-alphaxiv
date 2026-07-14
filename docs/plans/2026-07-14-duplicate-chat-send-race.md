# Duplicate Chat Send Race Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Prevent duplicate concurrent LLM streams from one paper-chat send.

**Architecture:** Add a synchronous boolean-ref single-flight gate acquired
before the first `await` in `ChatPanel.send()`. Keep React `busy` as presentation
state and use the gate as the concurrency invariant.

**Tech Stack:** React 18, TypeScript, Zustand persistence, Vitest.

---

### Task 1: Add the failing single-flight test

**Files:**
- Create: `frontend/src/lib/chatSendLock.test.ts`
- Create: `frontend/src/lib/chatSendLock.ts`

1. Add a test that acquires `{ current: false }` twice and expects `true`, then
   `false`; release it and expect the next acquisition to return `true`.
2. Run `npx vitest run src/lib/chatSendLock.test.ts` and verify it fails before
   the helper exports exist.
3. Implement `tryAcquireSendLock()` as a synchronous check-and-set and
   `releaseSendLock()` as an explicit reset.
4. Re-run the focused test and expect it to pass.

### Task 2: Integrate the gate into ChatPanel

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx`

1. Import the two gate helpers and create `sendLockRef` with `useRef(false)`.
2. Acquire the gate after input/provider validation but before the first
   `appendMessages()` await.
3. Install the controller and set `busy`/`Thinking...` immediately after the
   successful acquisition.
4. If persistence fails, surface `Failed to save message`, clear the turn's
   controller, release the gate, and return without calling the provider.
5. In the stream `finally`, clear only the matching controller, release the
   gate, and clear `busy`.

### Task 3: Run repository gates

**Files:** none.

1. Run the focused Vitest file and expect PASS.
2. Run `npm run typecheck` and expect zero TypeScript errors.
3. Run `npm test` and expect all frontend tests to pass.
4. Run backend `python -m pytest` using `Agent_env` and expect all tests to pass.

### Task 4: Deliver through the repository workflow

1. Commit the code, tests, design, and plan on
   `codex/fix-duplicate-chat-send`.
2. Push the branch and open a PR against `main`.
3. Wait for frontend and backend CI checks to pass, then merge.
4. Pull `main`, remove the worktree's `node_modules` junction, and remove the
   worktree safely.
