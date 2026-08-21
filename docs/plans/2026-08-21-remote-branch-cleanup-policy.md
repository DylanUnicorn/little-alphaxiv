# Remote Branch Cleanup Policy Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Remove merged temporary remote branches and require future worktree workflows to clean up both local and remote branches.

**Architecture:** Keep `main` protected and retain any branch that is unmerged, protected, or referenced by an open PR. Add the same lifecycle rule to the Codex and Claude repository guidance, then perform and verify the cleanup against GitHub's current branch state.

**Tech Stack:** Git worktrees, GitHub pull requests, GitHub REST API, Markdown.

---

### Task 1: Document the lifecycle rule

**Files:**
- Create: `AGENTS.md`
- Modify: `CLAUDE.md`

1. Require deletion of the merged worktree's local branch and remote branch.
2. Protect `main`, protected branches, open-PR branches, and unmerged branches from cleanup.
3. Require final remote-prune and branch/worktree verification.

### Task 2: Validate and merge the documentation

1. Confirm both guidance files carry equivalent cleanup language.
2. Commit on an isolated worktree branch.
3. Open a PR, wait for required CI checks, and merge only after they pass.

### Task 3: Clean and verify the repository

1. Re-read GitHub's open PRs and branches.
2. Delete only non-protected branches already merged into `main` and not used by an open PR.
3. Remove the task worktree and local task branch.
4. Verify the remote contains only intended branches and the local worktree list has no completed task worktree.
