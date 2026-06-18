# Sidebar: LLM-summarized conversation titles + date groups

**Date:** 2026-06-19
**Branch:** `worktree-conv-title-and-dates` (worktree off `origin/main`)

## Problem

The left sidebar indexed each conversation by the user's first message
truncated to 48 chars (`ChatPanel.send()` → `rename(c.id, text.slice(0, 48))`).
That is too blunt — a long question becomes a cut-off fragment, and paper
threads are indistinguishable. There was also no time organization: every
entry sat in one flat MRU list.

## Design

### 1. LLM-summarized titles

- New `completeChat()` in `lib/api.ts` — a **non-streaming** chat completion
  (`stream:false`). The `/api/llm` proxy already forwards non-streaming
  requests as plain JSON (`backend/app/routers/llm.py`). Used for short
  one-shot calls where SSE + tool-loop overhead is wasted.
- New `generateConversationTitle()` in `lib/llm.ts` — asks the conversation's
  effective model (per-conversation override → provider default, same
  precedence as `streamChat`) to summarize the first exchange (user question +
  assistant reply) into a ≤10-word title. For paper chats it is grounded in
  the paper's arxiv id / title / abstract / full-text excerpt. Output is
  normalized by `cleanTitle()` (strip quotes/labels, collapse whitespace, drop
  trailing period, cap ~80 chars). Returns `null` on any failure.
- `ChatPanel.send()` keeps the instant truncated-first-message title for
  immediate sidebar feedback, then — after the first turn's assistant reply
  lands — fires `maybeSummarizeTitle()` (fire-and-forget, never throws) which
  calls `generateConversationTitle()` and `rename()`s to the result. Triggered
  exactly once (guarded by `wasFirstTurn = c.messages.length === 0` at send
  start). Graceful fallback: on failure / no provider, the truncated title
  stays. No backfill of existing conversations (their first-message titles
  remain valid).
- Paper chats always pass at least the arxiv id in the title context (even
  before metadata/full text is cached), so the model always knows it is a
  paper thread.

### 2. Date-grouped sidebar (alphaxiv-style)

- New pure helper `lib/dates.ts` `groupByDate()` buckets items into
  **Today / Yesterday / Previous 7 Days / Previous 30 Days / `<Month Year>`**
  (reverse-chron; items keep input order so each section stays MRU). `now` is
  injectable for deterministic tests. Vitest covers the buckets, month
  ordering, and within-bucket order preservation.
- `Sidebar.tsx` renders conversation groups under `.conv-group` /
  `.conv-group-label` headers (CSS already existed from the themes commit,
  unused until now). General chats + paper groups are bucketed by
  `updated_at`.

### 3. Process

Implemented in an isolated worktree off `origin/main` (the main worktree
held another agent's uncommitted model-list/codebox work, which this branch
does not touch). Verified with the mock-LLM Playwright rig:
`tools/drive_titles.py` (new) confirms both general and paper chats get
summarized titles + a `Today` group, with no page errors; `tools/drive_fixes.py`
(extended to honor `APP_URL`) confirms no regression in empty-conv spam,
paper grouping, or the history panel. `mock_llm.py` was extended to answer
title-generation requests with distinct general/paper canned titles.

## Files

- `frontend/src/lib/api.ts` — `completeChat()`
- `frontend/src/lib/llm.ts` — `generateConversationTitle()`, `cleanTitle()`
- `frontend/src/lib/dates.ts` (+ `dates.test.ts`) — `groupByDate()`
- `frontend/src/components/ChatPanel.tsx` — `maybeSummarizeTitle()` + first-turn wiring
- `frontend/src/components/Sidebar.tsx` — date-grouped render
- `tools/mock_llm.py` — title-request handling
- `tools/drive_titles.py` (new), `tools/drive_fixes.py` — verification

## Out of scope

- No backfill of existing conversation titles.
- No date grouping in the paper-view `HistoryPanel` (left sidebar only, per
  request).
- `drive_fixes.py` Step 5 (theme) has a pre-existing stale selector unrelated
  to this change; left untouched.
