# Edit and Resend User Messages Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Let users copy any prompt or load it into the composer, correct it, and resend from that point without retaining later replies in model context.

**Architecture:** Add a persistence-safe `replaceFromUserMessage` store mutation and a composer-backed edit mode in `ChatPanel`. A memoized user-message action component supplies accessible Copy/Edit controls while the existing send pipeline handles the regenerated answer from the truncated prefix.

**Tech Stack:** React 18, TypeScript, Zustand, Tiptap/MathLive composer, CSS theme tokens, Vitest/react-test-renderer.

---

### Task 1: Define replacement semantics in the conversation store

**Files:**
- Modify: `frontend/src/store/conversations.ts`
- Test: `frontend/src/store/conversationMessageEdit.test.ts`

**Step 1: Write failing tests**

Cover exact prefix preservation, edited text/attachments, later-message
truncation, rejection of non-user indexes, and no local mutation when
`putConversation` fails.

**Step 2: Run the focused test and verify failure**

Run: `npx vitest run src/store/conversationMessageEdit.test.ts`

Expected: FAIL because `replaceFromUserMessage` is absent.

**Step 3: Implement the locked mutation**

Validate the target inside `withConvLock`, build
`messages.slice(0, index).concat(replacement)`, persist first, then publish the
updated conversation to Zustand.

**Step 4: Re-run the focused test**

Expected: all replacement-store tests PASS.

### Task 2: Add accessible user-message actions

**Files:**
- Create: `frontend/src/components/UserMessageActions.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/index.css`
- Test: `frontend/src/components/userMessageActions.test.tsx`

**Step 1: Write failing rendering and interaction tests**

Assert Copy/Edit accessible names, copied feedback, disabled Edit behavior, and
the stable CSS visibility contracts for hover, focus, and coarse pointers.

**Step 2: Run the focused test and verify failure**

Run: `npx vitest run src/components/userMessageActions.test.tsx`

Expected: FAIL because the component does not exist.

**Step 3: Implement the action row**

Use theme tokens, 30px icon targets with an expanded 40px pointer hit area,
instant existing Tooltip components, SVG icons, and a 1.5-second copied state.

**Step 4: Re-run the focused test**

Expected: all action tests PASS.

### Task 3: Reuse the composer for edit and resend

**Files:**
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/components/ChatComposer.tsx`
- Test: `frontend/src/components/chatMessageEdit.test.tsx`
- Test: `frontend/src/components/chatRenderPerformance.test.ts`

**Step 1: Write a failing ChatPanel flow test**

Click Edit on an older user message, assert composer hydration and focus
request, invoke Send, then assert replacement occurs before the regenerated
turn and uses only the preserved prefix plus edited message.

**Step 2: Run the focused tests and verify failure**

Run: `npx vitest run src/components/chatMessageEdit.test.tsx src/components/chatRenderPerformance.test.ts`

Expected: edit-flow assertions FAIL while the existing performance regression
continues to pass.

**Step 3: Implement edit state and send integration**

Add edit target state, cancel behavior, a composer focus nonce, an editing
context card, and source-history-aware context truncation. Clear edit state
only after persistence succeeds. Keep callbacks stable across draft updates.

**Step 4: Re-run the focused tests**

Expected: edit flow and render-count regression PASS.

### Task 4: Run release gates and inspect the UI

**Files:**
- Verify all modified frontend and documentation files.

**Step 1: Run static and unit gates**

Run: `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.

Expected: zero type errors, zero failing tests, successful Vite build, and no
whitespace errors.

**Step 2: Run the visible flow**

Start the sanctioned backend/frontend/mock-LLM rig, stop a response, hover a
user bubble, copy it, edit it, resend it, and verify the later reply is replaced
in both general and paper chat. Check dark/light, keyboard focus, and narrow
viewport behavior.

**Step 3: Commit the implementation**

Commit the tests and implementation together with a focused feature message.

**Step 4: Publish through the protected-main workflow**

Push `codex/edit-user-message`, open a PR, wait for frontend/backend CI to pass,
merge, pull local `main`, and remove the worktree after unlinking its
`frontend/node_modules` junction.
