# WYSIWYG Math Composer Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans (if available) or simply follow this plan task-by-task.

**Goal:** Replace the separate formula preview with one composer where prose stays plain and formulas are visually editable MathLive nodes.

**Architecture:** Use Tiptap for the composer document, selection, IME, paste, and history. Add a custom MathLive node plus a pure Markdown/document codec while preserving the existing string-based `value` and `onValueChange` boundary.

**Tech Stack:** React 18, TypeScript, Tiptap 3, MathLive, Vitest, react-test-renderer, CSS theme tokens.

---

### Task 1: Add the composer document codec

**Files:**
- Create: `frontend/src/lib/composerDocument.ts`
- Create: `frontend/src/lib/composerDocument.test.ts`

1. Write failing tests for prose, hard breaks, inline/display math, alternate delimiters, code exclusions, escaped dollars, incomplete delimiters, and Markdown round trips.
2. Run `npx vitest run src/lib/composerDocument.test.ts` and confirm the missing module failure.
3. Implement a code-aware scanner that emits Tiptap JSON text, hard-break, and math nodes without interpreting unrelated Markdown.
4. Implement deterministic serialization to the existing message string format.
5. Re-run the focused test and commit the codec.

### Task 2: Add the editable MathLive node

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Create: `frontend/src/components/composer/MathNode.tsx`
- Create: `frontend/src/components/composer/mathNodeExtension.ts`
- Create: `frontend/src/components/composer/mathNodeExtension.test.ts`

1. Add Tiptap and MathLive dependencies.
2. Write failing tests for node attributes, inline/display rendering metadata, and attribute updates.
3. Implement the custom Tiptap atom node and React node view containing `math-field`.
4. Wire input, focus exit, accessible labels, and readable fallback LaTeX.
5. Run the focused tests and commit the node.

### Task 3: Replace the textarea and Preview

**Files:**
- Modify: `frontend/src/components/ChatComposer.tsx`
- Replace: `frontend/src/components/chatComposerMathPreview.test.ts`
- Modify: `frontend/src/components/ChatPanel.tsx`

1. Write failing component tests for one editable surface, no Preview section, external value synchronization, formula updates, Enter send, Shift+Enter, paste, and busy state.
2. Run the focused component tests and confirm the failures.
3. Create the Tiptap editor with prose, hard breaks, history, custom math nodes, and controlled string synchronization.
4. Convert complete typed delimiters only outside IME composition and convert mixed pasted Markdown while preserving image paste behavior.
5. Remove the obsolete textarea key handler boundary from `ChatPanel`.
6. Re-run component and historical-render performance tests and commit the integration.

### Task 4: Style the unified editor

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/markdown-layout.test.ts`

1. Replace Preview assertions with failing assertions for the bounded editor surface and formula-node overflow.
2. Remove Preview CSS and add theme-aware editor, focus, placeholder, inline math, display math, disabled, and narrow-layout styles.
3. Include MathLive font CSS and ensure formulas inherit composer colors.
4. Re-run layout tests and commit the styles.

### Task 5: Verify behavior and performance

**Files:**
- Modify: `frontend/src/components/chatRenderPerformance.test.ts` only if the existing assertion needs a Tiptap mock boundary.

1. Run focused codec, node, composer, layout, and render-isolation tests.
2. Run `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
3. Start the worktree frontend against an isolated or existing backend and use the in-app browser to verify Chinese input, structured formula editing, keyboard navigation, paste, undo/redo, send, persistence, responsive paper view, and themes.
4. Fix every reproducible regression and repeat focused plus full gates.

### Task 6: Ship and deploy

1. Commit all remaining verified changes, push `codex/wysiwyg-math-composer`, and open a PR.
2. Wait for both frontend and backend CI jobs to pass, then merge through GitHub.
3. Fast-forward local `main`, safely remove the worktree after unlinking its `frontend/node_modules`, and prune the local feature branch.
4. From `deploy`, run `docker compose up -d --build` without removing orphans.
5. Verify `docker compose ps` reports healthy and `http://127.0.0.1:8000/api/health` returns HTTP 200.
