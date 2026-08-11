# PDF Page Zoom Race Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Follow this plan task-by-task.

**Goal:** Prevent an outdated pdf.js page render from leaving one PDF page at a stale zoom level.

**Architecture:** Keep lazy per-page rendering. Give each effect ownership of
the pdf.js canvas and text tasks, cancel those tasks during cleanup, and guard
all post-await DOM/state commits with the current effect's cancellation flag.

**Tech Stack:** React 18, TypeScript, pdf.js 4, Vitest, jsdom

---

### Task 1: Reproduce the stale page render

**Files:**
- Create: `frontend/src/components/pdfPageZoomRace.test.tsx`
- Modify: `frontend/src/components/PdfViewer.tsx`

1. Export `PdfPage` for focused component testing without changing production rendering.
2. Mock pdf.js page/render tasks and an immediately intersecting observer.
3. Start a render at one zoom, rerender before its promise settles, and assert the first task is cancelled.
4. Run `npx vitest run src/components/pdfPageZoomRace.test.tsx` and confirm it fails before the fix.

### Task 2: Cancel outdated work

**Files:**
- Modify: `frontend/src/components/PdfViewer.tsx`

1. Capture the canvas `RenderTask` returned by `page.render()`.
2. Cancel it in the effect cleanup alongside the text task.
3. Guard render completion, later text-layer work, and page cleanup against stale effects.
4. Run the focused test and confirm it passes.

### Task 3: Validate the frontend

**Files:**
- Test: `frontend/src/components/pdfPageZoomRace.test.tsx`

1. Run `npm run typecheck`.
2. Run `npm test`.
3. Run `npm run build`.
4. Exercise repeated zoom changes in a loaded PDF and confirm all visible page canvases share the expected CSS width.
