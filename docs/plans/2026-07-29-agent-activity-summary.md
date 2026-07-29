# Agent Activity Summary Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Replace blank tool-call rows with one readable, automatically folded Agent activity summary per assistant turn.

**Architecture:** Add a pure render-model helper that groups OpenAI assistant/tool protocol messages and derives safe summaries. Render the grouped item through a dedicated accessible disclosure component, while preserving the stored messages and model context unchanged.

**Tech Stack:** React 18, TypeScript, CSS theme tokens, Vitest.

---

### Task 1: Activity render model

**Files:**
- Create: `frontend/src/lib/agentActivity.ts`
- Test: `frontend/src/lib/agentActivity.test.ts`

**Step 1: Write the failing tests**

Cover a single tool round, several tool-call rounds before one final answer,
query extraction, result counts and the first three titles, failed results, and
malformed JSON.

**Step 2: Run the focused test and verify failure**

Run: `npx vitest run src/lib/agentActivity.test.ts`

Expected: FAIL because `agentActivity.ts` does not exist.

**Step 3: Implement the minimal pure helper**

Export `buildChatRenderItems(messages)` plus types for message and activity
items. Match results by `tool_call_id`, prefer `ui.papers`, safely parse array
content, cap titles at three, and never include raw payloads in the result.

**Step 4: Run the focused test**

Run: `npx vitest run src/lib/agentActivity.test.ts`

Expected: PASS.

### Task 2: Accessible activity disclosure

**Files:**
- Create: `frontend/src/components/AgentActivity.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`
- Modify: `frontend/src/index.css`

**Step 1: Render grouped items instead of raw protocol rows**

Memoize `buildChatRenderItems(conv.messages)`. Render ordinary messages through
`MessageRow` and activity items through `AgentActivity`. Treat a trailing
activity item as active only while the turn is busy and no final answer is
streaming.

**Step 2: Implement disclosure behavior**

Use a native `details`/`summary` control. Open when activity starts, fold when
the final answer starts, and allow subsequent manual toggling. The summary must
announce tool and result counts; the body lists friendly tool name, query,
status, count, and up to three titles.

**Step 3: Add restrained theme-aware styling**

Use existing `--bg-*`, `--border`, `--text-*`, `--accent`, `--danger`, and
`--ok` tokens. Add visible `:focus-visible`, responsive wrapping, and a
`prefers-reduced-motion` rule. Do not add decorative animation or hardcoded
theme colors.

**Step 4: Run typecheck and the focused test**

Run: `npm run typecheck`

Expected: PASS.

Run: `npx vitest run src/lib/agentActivity.test.ts`

Expected: PASS.

### Task 3: Persist failed tool outcomes

**Files:**
- Modify: `frontend/src/lib/llm.ts`

**Step 1: Route failure tool messages through the existing callback**

Construct one `toolMsg` in each OpenAlex, Semantic Scholar, and web-search
catch branch; push it to both model context and `newMessages`, then call
`callbacks.onToolMessage(toolMsg)` so the UI and database receive failures.

**Step 2: Run the full frontend gates**

Run: `npm test`

Expected: all Vitest tests pass.

Run: `npm run typecheck`

Expected: PASS.

### Task 4: Browser verification and delivery

**Files:**
- Modify if needed after inspection: `frontend/src/components/AgentActivity.tsx`
- Modify if needed after inspection: `frontend/src/index.css`

**Step 1: Verify visually**

Use the sanctioned local app and mock LLM. Confirm the disclosure updates during
tool use, folds before the final response, expands by mouse and keyboard, works
in paper/general chat, and creates no blank vertical gap.

**Step 2: Commit and deliver**

Commit the design, plan, implementation, and tests. Push the branch, open a PR,
wait for both CI jobs, merge after green, update local `main`, and remove the
worktree safely.
