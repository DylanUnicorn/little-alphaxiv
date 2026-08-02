# PDF Composer Typing Performance Design

## Problem

Typing or deleting text in the paper-view composer becomes visibly uneven when
the conversation contains rendered Markdown, KaTeX, paper cards, branches, or
agent activity. The original performance fix memoized each `MessageRow`, but a
later branching feature passes a newly-created `createBranch` callback on every
`ChatPanel` render. Updating the controlled composer value therefore defeats
the memo boundary and re-renders every assistant message on every keystroke.

## Design

Keep the controlled composer and its current send, attachment, selected-text,
and auto-grow behavior. Restore the intended render boundary by stabilizing the
branch callback with `useCallback`. Memoize completed agent-activity groups as
well, because they are another history-only subtree whose inputs do not change
while the user edits a draft.

The fix deliberately stays inside the chat surface. It does not debounce the
textarea, delay visible text, change PDF rendering, or alter conversation
persistence. The user's keystroke remains synchronous; only unrelated history
work is skipped.

## Verification

Add a render-regression test around memoized history rows: composer-only parent
updates must preserve callback identity and must not re-run historical Markdown
rendering. Run the focused test, the full frontend Vitest suite, TypeScript
typecheck, production build, and `git diff --check`. After merge, rebuild the
local Docker deployment and verify both Compose health and `/api/health`.
