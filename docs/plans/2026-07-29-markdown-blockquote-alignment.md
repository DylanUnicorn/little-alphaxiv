# Markdown Blockquote Alignment Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Center assistant blockquote content optically by making its vertical edge spacing symmetric.

**Architecture:** Preserve the shared Markdown renderer and correct the layout in its existing theme-aware CSS. Normalize only the blockquote's outer child margins so spacing between multiple children remains intact.

**Tech Stack:** React 18, react-markdown, CSS custom properties, Vitest

---

### Task 1: Protect blockquote edge spacing

**Files:**
- Create: `frontend/src/markdown-layout.test.ts`
- Modify: `frontend/src/index.css:1065`

**Step 1: Write the failing test**

Import `index.css` as text and assert that assistant blockquotes use 8px
vertical padding and normalize first-child top and last-child bottom margins.

**Step 2: Run the focused test and verify it fails**

Run: `npm test -- src/markdown-layout.test.ts`

Expected: FAIL because the current blockquote uses 3px vertical padding and
does not normalize nested paragraph edge margins.

**Step 3: Implement the minimal CSS fix**

Change the blockquote padding to `8px 13px` and add child-edge selectors that
set only the first top margin and last bottom margin to zero.

**Step 4: Run the focused test and verify it passes**

Run: `npm test -- src/markdown-layout.test.ts`

Expected: PASS.

### Task 2: Verify the frontend

**Files:**
- No additional files.

**Step 1: Run static validation**

Run: `npm run typecheck`

Expected: PASS.

**Step 2: Run the complete frontend suite**

Run: `npm test`

Expected: PASS.

**Step 3: Verify visually**

Render a representative multiline blockquote in the app and confirm balanced
top and bottom whitespace in at least one dark and one light theme.

**Step 4: Commit**

Commit the stylesheet, regression test, design note, and implementation plan.
