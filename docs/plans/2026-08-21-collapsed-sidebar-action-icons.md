# Collapsed Sidebar Action Icons Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Replace the collapsed sidebar's platform-dependent Open Paper and Settings glyphs with prominent, theme-aware line icons.

**Architecture:** Add one dependency-free React SVG component with two named variants, then use it inside the existing collapsed-sidebar buttons. Keep the button component vocabulary, Tooltip behavior, routing, sizing, and theme tokens unchanged; add only the SVG sizing hook required for optical alignment.

**Tech Stack:** React 18, TypeScript, CSS, Vitest, react-test-renderer.

---

### Task 1: Lock the icon contract with a failing test

**Files:**
- Create: `frontend/src/components/SidebarActionIcon.test.tsx`
- Create: `frontend/src/components/SidebarActionIcon.tsx`

**Step 1: Write the failing test**

Test that both named variants render a 24×24 SVG with `fill="none"`, `stroke="currentColor"`, a shared class, consistent line caps/joins, and `aria-hidden`. Assert that Open Paper contains a document outline plus horizontal/vertical add marks, while Settings contains a gear body and center circle.

**Step 2: Run the focused test and verify failure**

Run: `npm test -- --run src/components/SidebarActionIcon.test.tsx`

Expected: FAIL because `SidebarActionIcon` does not exist.

**Step 3: Implement the minimal component**

Create `SidebarActionIcon.tsx` with a closed `"open-paper" | "settings"` prop union and dependency-free inline SVG paths. Keep the SVG decorative so Tooltip remains the button's accessible-name owner.

**Step 4: Run the focused test and verify pass**

Run: `npm test -- --run src/components/SidebarActionIcon.test.tsx`

Expected: PASS.

### Task 2: Integrate the icons into the collapsed sidebar

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/index.css`

**Step 1: Replace the two platform glyphs**

Import `SidebarActionIcon`; render `name="open-paper"` and `name="settings"` inside their existing buttons. Do not change callbacks, Tooltip labels, order, or button classes.

**Step 2: Add the shared visual box**

Add `.sidebar-action-icon` next to the collapsed-sidebar button styles with a 20×20 block box and `flex: none`. Do not add hard-coded colors; the SVG inherits `currentColor`.

**Step 3: Run focused and full verification**

Run: `npm test -- --run src/components/SidebarActionIcon.test.tsx`

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: all commands exit 0.

### Task 3: Visual verification and delivery

**Files:**
- Verify: collapsed sidebar in the running frontend

**Step 1: Inspect real rendered states**

Check light and dark themes at the collapsed 48px sidebar width. Verify default, hover, and keyboard focus states, optical centering, consistent stroke weight, and no layout shift.

**Step 2: Commit and open the pull request**

Commit the design, plan, implementation, and tests. Push `codex/polish-collapsed-sidebar-icons`, open a PR, wait for frontend and backend CI, merge only after both are green, update local `main`, then remove the worktree safely after unlinking `frontend/node_modules`.
