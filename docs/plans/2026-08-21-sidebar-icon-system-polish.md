# Sidebar Icon System Polish Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Replace the sidebar's remaining platform-dependent action glyphs with one coherent, theme-aware SVG icon system.

**Architecture:** Extend the existing dependency-free `SidebarActionIcon` component from two to six closed variants. Reuse it in collapsed, expanded-header, and expanded-footer actions; use CSS only for contextual sizing and optical alignment, while preserving all behavior and theme tokens.

**Tech Stack:** React 18, TypeScript, CSS, Vitest, react-test-renderer, Playwright.

---

### Task 1: Expand the test contract

**Files:**
- Modify: `frontend/src/components/SidebarActionIcon.test.tsx`

**Step 1: Add failing SVG variant tests**

Cover `expand-sidebar`, `collapse-sidebar`, `new-chat`, and `log-out`. Require the common 24×24, `currentColor`, rounded line contract; require 2.4px only for `new-chat`.

**Step 2: Add failing integration and CSS tests**

Read `Sidebar.tsx` and assert the old `»`, `«`, `⚙ Settings`, and `⎋ Log out` patterns are absent. Require flex centering for `.icon-btn` and `.settings-btn`, 18px footer icons, and a 16px header collapse icon.

**Step 3: Run the focused test**

Run: `npx vitest run src/components/SidebarActionIcon.test.tsx`

Expected: FAIL because the new variants and integrations do not exist.

### Task 2: Implement and integrate the unified icons

**Files:**
- Modify: `frontend/src/components/SidebarActionIcon.tsx`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/index.css`

**Step 1: Add the new SVG variants**

Add mirrored panel arrows, a centered plus, and a door-with-arrow logout icon. Keep Open Paper and Settings unchanged.

**Step 2: Replace platform glyphs**

Use the new component for collapsed expand/new-chat, expanded header collapse, Settings, and Log out. Preserve existing callbacks, labels, Tooltip behavior, and logout sequence.

**Step 3: Add contextual sizing**

Make `.icon-btn` flex-centered globally within the sidebar. Set footer action icons to 18px with a 7px gap; set the compact header icon to 16px.

**Step 4: Run the focused test**

Run: `npx vitest run src/components/SidebarActionIcon.test.tsx`

Expected: PASS.

### Task 3: Verify and deliver

**Step 1: Run frontend gates**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Run: `git diff --check`

Expected: all commands exit 0; existing bundle warnings may remain.

**Step 2: Inspect the actual UI**

Use Playwright against the worktree frontend and local backend. Check light/dark themes, collapsed/expanded layouts, SVG sizes, zero center offset, hover/focus, and console errors. Save light/dark evidence screenshots.

**Step 3: Ship**

Commit, push, open a PR, wait for frontend/backend CI, merge, update local `main`, rebuild Docker safely so the running app contains the change, verify `/api/health`, then remove the worktree and both local and remote task branches.
