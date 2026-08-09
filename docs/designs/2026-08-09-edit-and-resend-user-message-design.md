# Edit and Resend User Messages

> Superseded for interaction behavior by
> [Inline Last-Message Editing](./2026-08-09-inline-last-message-edit-design.md).
> The persistence and truncation rules below remain the foundation; the newer
> design moves editing out of the bottom composer and limits Edit to the latest
> eligible user prompt.

## Interaction design

Each user message gains a compact action row aligned to the lower-right edge of
its bubble. The row contains Copy and Edit icon buttons, following the supplied
reference without adding a timestamp. On pointer devices it fades in when the
bubble is hovered; it also appears for `:focus-within`, and remains visible on
coarse-pointer devices where hover does not exist. Both controls have tooltips,
accessible names, visible keyboard focus, and theme-token colors. Copy writes
the original Markdown/plain message text and briefly changes to a check icon.

Edit reuses the existing controlled composer rather than introducing a second,
less capable text field. It loads the selected message text and image
attachments into the composer, focuses the caret at the end, and shows an
"Editing message" context card that explains that sending will replace the
selected message and later replies. Removing that card cancels the edit and
restores an empty composer. While a turn is generating, Edit is disabled; Copy
remains available. This matches the requested stop-then-edit flow and avoids a
race between an in-flight stream and persisted message replacement.

## Data flow and failure behavior

Resending is an in-place correction on the current conversation. Only when the
user presses Send does the store atomically replace the selected user message
and truncate every later protocol message. The LLM request is built from the
preserved prefix plus the edited message, so discarded assistant/tool output
cannot leak into the regenerated answer. The original conversation settings,
paper context, provider, and message attachments remain unchanged.

The store mutation stays inside the existing per-conversation write lock. It
validates that the target still exists and is a user message, persists the
replacement before generation begins, and leaves local state untouched if the
server write fails. On failure, the composer retains the edited draft for a
retry and displays the existing chat notice. On success, edit mode clears and
the normal streaming, stop, partial-output, error, usage, and first-turn title
paths continue unchanged. Editing the first question refreshes the fallback
and generated conversation title; editing later questions does not.

## Alternatives considered

1. Inline bubble editing was rejected because it would duplicate the
   MathLive/Tiptap composer, attachment handling, keyboard semantics, and
   accessibility behavior.
2. Creating a new branch was rejected for this increment because branches are
   currently paper-only; widening lineage, sidebar grouping, and navigation for
   general chats would turn a correction affordance into a history-model
   migration.
3. Mutating the message as soon as Edit is clicked was rejected because Cancel
   would no longer be lossless and an interrupted edit could silently remove
   later replies.

## Verification

Store tests cover validation, server-first persistence, exact truncation, and
failure rollback. Component tests cover hover-action rendering contracts,
copy feedback, edit draft hydration, cancellation, disabled Edit during a
turn, replacement before regeneration, and preservation of memoized historical
Markdown during ordinary draft changes. Typecheck, the full Vitest suite, the
production build, and a browser pass in dark/light themes complete the gate.
