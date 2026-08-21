# Sidebar Conversation Type Icons Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Make chat and paper rows in the history sidebar immediately distinguishable with larger, high-contrast line icons.

**Architecture:** Add a small presentational React component that owns the two SVG drawings, then use it in `Sidebar`. Style its shared container and state variants with the existing theme tokens. Keep conversation behavior and data flow unchanged.

**Tech Stack:** React 18, TypeScript, CSS theme tokens, Vitest, react-test-renderer.

---

### Task 1: Add the icon component and regression test

**Files:**
- Create: `frontend/src/components/SidebarConversationTypeIcon.tsx`
- Create: `frontend/src/components/SidebarConversationTypeIcon.test.tsx`

1. Write a test that renders `general` and `paper` variants and asserts their distinct classes, SVG paths, `viewBox`, and `aria-hidden` contract.
2. Run the focused test and confirm it fails because the component does not exist.
3. Implement the two dependency-free SVG variants with rounded strokes and `currentColor`.
4. Re-run the focused test and confirm it passes.

### Task 2: Replace emoji and add theme-aware visual states

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/index.css`

1. Import the new component and replace the `💬` and `📄` row tags.
2. Give the container a 26px fixed footprint and the drawing an 18px size.
3. Use `--bg-3`, `--text`, `--accent-soft`, `--accent`, and `--accent-contrast` for default, hover, and active states.
4. Preserve title truncation, count badges, delete controls, row height, and navigation behavior.

### Task 3: Verify and ship

**Files:**
- Verify all modified frontend files.

1. Run the focused test, full Vitest suite, typecheck, production build, and `git diff --check`.
2. Start the frontend and visually verify the sidebar at desktop width in the Alphaxiv theme, including inactive, hover, and active rows.
3. Commit, push `codex/sidebar-line-icons`, open a PR, wait for both CI jobs, and merge only after they pass.
