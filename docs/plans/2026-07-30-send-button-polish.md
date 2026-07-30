# PDF Chat Send Button Polish Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Reduce the visual weight of the PDF-side chat send control while preserving its usability and existing states.

**Architecture:** Keep the shared `ChatComposer` markup and behavior unchanged. Apply a narrowly scoped CSS adjustment in the paper-view surface so general chat remains untouched, while the visible circle and arrow shrink together and the pointer target remains at least 44px.

**Tech Stack:** React, TypeScript, existing token-based CSS, Vitest, TypeScript compiler

---

### Task 1: Refine the paper-view send control

**Files:**
- Modify: `frontend/src/index.css`

**Step 1:** Confirm the paper-view ancestor selector and current send-button dimensions.

**Step 2:** Add the smallest paper-view-specific override for the button circle, glyph, and invisible pointer target.

**Step 3:** Run `npm run typecheck` and the focused composer tests.

**Step 4:** Inspect the rendered PDF-side composer at desktop width and confirm default, hover, disabled, and stop states retain a clear affordance.

**Step 5:** Commit, push, open a PR, wait for CI, merge, and clean up the worktree according to repository workflow.
