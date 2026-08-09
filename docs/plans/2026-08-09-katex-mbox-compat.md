# KaTeX `\mbox` Compatibility Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task with TDD.

**Goal:** Render legacy `\mbox{...}` emitted inside AI formulas without showing red KaTeX error text.

**Architecture:** Reuse the code-aware math normalization pipeline. Scan only complete normalized math ranges and replace the `\mbox` command token with `\text`, leaving message persistence and non-math content unchanged.

**Tech Stack:** TypeScript, remark-math, rehype-katex, KaTeX, Vitest.

---

### Task 1: Specify compatibility behavior

**Files:**
- Modify: `frontend/src/lib/mathMarkdown.test.ts`

1. Add a failing render test for `W\mbox{-MSA Block}`.
2. Add coverage for nested `\operatorname{signed\mbox{-}log}`.
3. Add negative cases for prose, inline/fenced code, and unmatched math.
4. Run `npx vitest run src/lib/mathMarkdown.test.ts` and confirm the new render assertion fails.

### Task 2: Normalize commands only inside math

**Files:**
- Modify: `frontend/src/lib/mathMarkdown.ts`

1. Add a delimiter-aware math-body transformer using the existing escape and close-delimiter helpers.
2. Rewrite only `\mbox` followed by an opening brace to `\text`.
3. Re-run the focused tests and typecheck.

### Task 3: Validate and deploy

**Files:**
- No additional production files expected.

1. Run the full frontend test suite and production build.
2. Run `git diff --check`.
3. Browser-test the exact two MSA equations.
4. Commit, push, open a PR, wait for CI, merge, and rebuild Docker.
5. Verify container health, HTTP 200, and the deployed browser output.
