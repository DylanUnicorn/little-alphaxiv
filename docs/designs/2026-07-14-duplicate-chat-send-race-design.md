# Duplicate Chat Send Race Design

## Problem

The paper-chat composer can accept the same send action more than once before
React renders `busy=true`. `ChatPanel.send()` currently awaits the first
conversation persistence write before setting `busy`. A second click or Enter
event during that await observes the stale `busy=false` render, appends the same
user message again, and starts another LLM stream. The two streams share UI
state while only the newest `AbortController` remains reachable from Stop. This
can leave the paper pane showing `thinking` after one response has already been
stored.

The production database captured this exact shape: two adjacent byte-identical
user messages followed by one assistant message. The Docker container remained
healthy and had no active upstream socket after the response was persisted, so
the container itself was not deadlocked.

## Design

Use a synchronous single-flight gate owned by each `ChatPanel` instance. The
gate is acquired before the first asynchronous operation in `send()`, so a
second invocation in the same render immediately returns even though React has
not committed the `busy` state yet. `busy` remains the rendering control for
the composer and Stop button; the gate is the concurrency invariant.

Create a small framework-independent helper with `tryAcquireSendLock()` and
`releaseSendLock()` so the atomic transition is unit-testable in the existing
Node Vitest environment. `ChatPanel` stores the gate in a `useRef<boolean>`.
After acquisition it immediately installs the turn's `AbortController`, marks
the UI busy, and persists the user message. Persistence failure releases the
gate and reports a local error without starting an LLM request. The normal
stream path releases the gate in its existing `finally` block and only clears
the abort ref when it still belongs to that turn.

No backend API, SSE dialect, timeout, conversation schema, or provider behavior
changes. The existing Stop semantics remain: abort the single active request,
preserve partial assistant text, and unlock after cleanup.

## Alternatives rejected

- Moving `setBusy(true)` earlier: React state updates are asynchronous, so two
  invocations in the same event-loop window can still pass the stale guard.
- Backend idempotency keys: robust across clients, but it changes request and
  persistence protocols for a UI-local race and is disproportionate here.
- Disabling the button only: Enter and programmatic callbacks can still race,
  and DOM disabled state also depends on a render completing.

## Verification

- Unit test: the first acquisition succeeds, an immediate second acquisition
  fails, and acquisition succeeds again only after release.
- Frontend gates: `npm run typecheck` and `npm test`.
- Backend regression gate: full `pytest`, because the PR must satisfy both CI
  jobs even though backend code is unchanged.
