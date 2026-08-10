# arXiv Search Recovery Design

**Date:** 2026-08-10

## Problem

The arXiv proxy sends bursts directly to the public Atom API. arXiv answers
with `429 Rate exceeded`, but the proxy rewrites every non-200 response to 502.
In the browser tool loop, `search_arxiv` is the only search branch without an
error-to-tool-result conversion. Its exception escapes after the assistant
function-call message has already been persisted, leaving no matching tool
output. A later user message then fails upstream with `No tool output found for
function call`.

## Design

All arXiv Atom requests share one process-local request scheduler. Starts are
spaced by the public API's three-second minimum. Network failures, 429, and 5xx
responses receive one bounded retry; deterministic 4xx responses do not. If a
429 still persists, the proxy preserves it as 429 with a retry hint instead of
mislabeling it as 502.

The frontend converts an arXiv search exception into the same paired tool
result used by the other search providers. The result includes an actionable
instruction to revise the query or use another enabled source. It is appended
to both the provider request history and persisted conversation history before
the tool loop continues. The model can therefore retry, fall back, or explain
the remaining limitation, while the six-round loop cap prevents unbounded
searching.

## Verification

- Backend tests cover 429-to-success retry and persistent-429 status fidelity.
- Frontend tests cover a failed arXiv call followed by a successful model
  continuation, including exact function-call/tool-output pairing.
- Full backend pytest, frontend typecheck/Vitest/build, live Docker health, and
  a real `/api/search` request are release gates.
