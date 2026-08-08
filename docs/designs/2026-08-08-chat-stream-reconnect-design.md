# Chat Stream Reconnect Design

## Problem

Paper-conversation branches use the same streaming path as normal chat. A transient
`ConnectError` can therefore occur immediately after a branch is created even though
the branch itself was persisted correctly. The backend currently retries once before
the first upstream byte. If both attempts fail, the frontend persists the raw proxy
error as both assistant content and `ui.error`, so one failure is rendered twice.

## Design

Keep the backend retry as the first, fast recovery layer. Add one browser-level
reconnect in `streamChat` for connection failures that happen before any meaningful
SSE progress reaches the browser. Progress means content, reasoning, or a tool-call
fragment; after any such progress, replay is forbidden because a second request could
duplicate an answer or tool action. Abort errors and HTTP/provider errors are also not
retried. The retry uses a short bounded delay, observes the original `AbortSignal`,
and reports `Reconnecting…` through a callback so the existing chat status area makes
the recovery visible.

Use a typed stream error carrying `retryable` and `receivedProgress` metadata instead
of matching arbitrary user-facing strings. Proxy-generated connection failures are
retryable only when no progress was parsed. Browser `fetch` network failures are
retryable by nature; explicit aborts are not. The second failure is surfaced normally.

When no partial answer exists, persist a single assistant error presentation: the
friendly visible content only, without duplicating the same value in `ui.error`.
When partial output exists, preserve it and retain the smaller interruption detail.
This keeps existing history semantics and makes partially generated answers auditable.
Connection exception names are translated into an actionable Docker/upstream-service
message; raw details remain in backend logs instead of leaking into the chat transcript.

## Verification

Unit tests cover recovery before progress, refusal to replay after progress, abort
handling, retry exhaustion, and reconnect status. A component-level regression test
or extracted helper test verifies that an empty-buffer error produces one visible
message. Run frontend typecheck and the complete Vitest suite; backend behavior is
unchanged, so run its focused stream tests as a regression gate.
