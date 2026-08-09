# Inline Last-Message Editing

## Interaction

Only the latest user prompt on the current branch exposes Edit. Earlier user
messages keep Copy but do not render a disabled or misleading Edit control. A
paper child branch cannot edit a user message inherited at or before
`branch_from_message_index`; if that is the last visible user prompt, the
branch has no editable prompt until the user sends its own follow-up.

Edit transforms the original bubble into a compact controlled textarea. It
loads the canonical Markdown/LaTeX source and existing image attachments,
focuses the caret at the end, and grows with the content up to a bounded height.
Enter inserts a newline, Ctrl/Cmd+Enter resends, and Escape, Cancel, or moving
focus outside the whole inline editor leaves the conversation unchanged.
Moving focus between the textarea, attachments, and action buttons is internal
and does not cancel. Existing attachments can be removed locally before
resending. The bottom composer remains visible but is locked while inline edit
mode is active so the interface never holds two sendable drafts.

## Commit boundary and failures

Opening or changing the inline draft does not mutate history. Resend calls the
existing `replaceFromUserMessage` store operation, which persists the edited
message and truncates every later protocol message under the conversation write
lock. Only after persistence succeeds does the inline editor close and the LLM
receive the preserved prefix plus the replacement prompt. A failed persistence
write leaves the textarea and attachments mounted for correction or retry.

Editing is unavailable while the conversation is generating. The user stops
the active turn first, which prevents a stale stream from racing the replacement.
Normal bottom-composer drafts and selected-paper-text context remain intact
through entering and cancelling inline edit mode.

## Accessibility and responsive behavior

Copy and Edit retain accessible names, tooltips, focus rings, coarse-pointer
visibility, and theme-token colors. The inline textarea has a stable accessible
name; action buttons expose native disabled states. At narrow widths the editor
uses the full message column and wraps its keyboard hint above the actions.
Reduced-motion preferences suppress nonessential transitions.

## Verification contract

Component tests cover last-only eligibility, inherited-branch exclusion,
in-bubble hydration, composer locking, cancel, empty-submit prevention,
attachment preservation/removal, resend context, and persistence failure.
Release gates remain typecheck, full Vitest, production build, visible browser
checks in both themes and a narrow viewport, followed by protected-main PR/CI
and a verified Docker rebuild.
