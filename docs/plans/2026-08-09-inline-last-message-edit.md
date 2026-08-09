# Inline Last-Message Editing Implementation Plan

**Goal:** Edit and resend the latest eligible user prompt directly inside its
original bubble without using the bottom composer.

1. Add a controlled inline editor with raw Markdown/LaTeX text, attachment
   preservation/removal, focus, auto-resize, Escape cancellation, and
   Ctrl/Cmd+Enter resend.
2. Compute one editable user-message index per conversation, excluding inherited
   paper-branch history, and render Copy-only actions everywhere else.
3. Route inline resend through the existing persistence-first replacement and
   truncated-context pipeline; keep the editor mounted on save failure.
4. Add an independent disabled state to the bottom composer so edit mode locks
   drafting without replacing the Send button with Stop.
5. Cover the component, keyboard, attachment, branch, failure, and context
   contracts with focused tests, then run typecheck, all Vitest tests, build,
   and browser verification.
6. Push a worktree branch, merge only after both CI jobs pass, update local main,
   clean the worktree safely, and rebuild/health-check the Docker deployment.
