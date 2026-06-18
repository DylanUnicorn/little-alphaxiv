# PDF Annotation Layer + Code-Block Highlight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Zotero-style annotation layer (text/rect/freehand/highlight) to the PDF preview with per-paper persistence and undo/redo, plus syntax highlighting for code blocks in the right chat panel.

**Architecture:** Annotation layer = an SVG/HTML overlay per PDF page (`pdf.js` canvas + textlayer untouched), storing page-normalized coords (0..1) so zoom/repaint never drifts. A flat immutable annotation array + pure op-stack reducer drives undo/redo; a zustand store wraps it with IndexedDB persistence and UI state (tool/color/selection). Highlight sits in its own layer below the textlayer; rect/draw/text sit in a layer above. Code-block highlighting uses highlight.js wired into react-markdown's `code` component.

**Tech Stack:** React 18 + TypeScript, pdf.js v4 (existing), zustand (existing), idb (existing), vitest (new), highlight.js (new).

## Global Constraints

- Work inside the worktree at `E:\Hust\little_alphaxiv\.claude\worktrees\pdf-annotation-layer`, branch `worktree-pdf-annotation-layer`.
- Frontend lives in `frontend/`. Run `npm run typecheck` after every task — it MUST pass (0 errors) before commit.
- All annotation coordinates are page-normalized (0..1) in storage; denormalize to current page pixel size only at render/pointer-time.
- CSS uses the project's `:root` theme vars (`--bg`, `--bg-2`, `--bg-3`, `--border`, `--text`, `--text-dim`, `--accent`, `--accent-2`, `--danger`, `--ok`). New CSS is APPENDED to the END of `frontend/src/index.css` (currently 379 lines) — never edit existing lines, to avoid merge conflicts with the parallel UI-themes worktree.
- Palette is exactly 6 colors: `#FFEB3B #A5F3A0 #93C5FD #F9A8D4 #FDBA74 #C4B5FD`.
- Highlight layer z-index = 1 (below textlayer z-index 2); annot layer z-index = 3 (above textlayer).
- Each task ends with `git add` + `git commit` with a `feat:`/`test:`/`chore:` prefix.
- Pure logic (coords, op-stack) is TDD with vitest. UI tasks verify via typecheck + manual steps listed in each task.
- Design spec: `docs/designs/2026-06-18-pdf-annotation-layer-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `frontend/src/types.ts` | Add `Annotation`, `Op`, `NormRect`, `NormPoint`, `AnnotationType`, `Tool` types |
| `frontend/src/lib/annotations.ts` | NEW. `PALETTE`, id gen, normalize/denormalize pure functions |
| `frontend/src/lib/opstack.ts` | NEW. Pure `commit`/`undoOp`/`redoOp`/`inverse` reducer over flat annotation array |
| `frontend/src/lib/db.ts` | DB v1→v2: add `annotations` store + CRUD functions |
| `frontend/src/store/annotations.ts` | NEW. zustand store wrapping opstack + persistence + UI state |
| `frontend/src/components/AnnotationToolbar.tsx` | NEW. Toolbar: color, 4 tools, undo/redo |
| `frontend/src/components/HighlightLayer.tsx` | NEW. Render highlight rects + create-on-select with color bubble |
| `frontend/src/components/AnnotLayer.tsx` | NEW. Render rect/draw/text + create + select/move/resize/delete |
| `frontend/src/components/PdfViewer.tsx` | Mount layers in `PdfPage`, mount `AnnotationToolbar`, ESC + shortcuts, pointer-events toggle |
| `frontend/src/views/PaperView.tsx` | Load annotations into store on mount |
| `frontend/src/components/CodeBlock.tsx` | NEW. highlight.js code block + copy button |
| `frontend/src/components/ChatPanel.tsx` | Wire `components={{ code }}` into 3 ReactMarkdown usages |
| `frontend/src/index.css` | APPEND layer/toolbar/code-block styles |
| `frontend/vitest.config.ts` | NEW. vitest config |
| `frontend/src/lib/annotations.test.ts` | NEW. coord function tests |
| `frontend/src/lib/opstack.test.ts` | NEW. op-stack state machine tests |

---

### Task 1: Vitest setup + types + PALETTE + coordinate pure functions (TDD)

**Files:**
- Modify: `frontend/package.json` (add `vitest`, `@vitest/ui` devDeps + `test` script)
- Create: `frontend/vitest.config.ts`
- Modify: `frontend/src/types.ts` (append types)
- Create: `frontend/src/lib/annotations.ts`
- Create: `frontend/src/lib/annotations.test.ts`

**Interfaces:**
- Produces: `PALETTE`, `newId()`, `normalizePoint`, `denormalizePoint`, `normalizeRect`, `denormalizeRect`, `rectsToNorm`, types `Annotation`/`Op`/`NormRect`/`NormPoint`/`AnnotationType`/`Tool`/`PageSize`. Consumed by every later task.

- [ ] **Step 1: Install vitest**

Run:
```bash
cd frontend && npm install -D vitest@^1.6.0 2>&1 | tail -3
```
Expected: `added N packages` with no error.

- [ ] **Step 2: Add test script + create vitest config**

Edit `frontend/package.json` — add to `scripts`:
```json
    "test": "vitest run",
    "test:watch": "vitest"
```
(Add these two lines after the existing `"typecheck"` line, keeping valid JSON commas.)

Create `frontend/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add types to `frontend/src/types.ts`**

Append to the end of `frontend/src/types.ts`:
```ts
// ---------- PDF annotations ----------

export type AnnotationType = "highlight" | "rect" | "draw" | "text";
export type Tool = "none" | "text" | "rect" | "draw" | "highlight";

/** Page-normalized rect (0..1 relative to page width/height). */
export interface NormRect { x: number; y: number; w: number; h: number; }
/** Page-normalized point (0..1). */
export interface NormPoint { x: number; y: number; }

export interface Annotation {
  id: string;
  arxiv_id: string;
  page: number; // 1-based
  type: AnnotationType;
  color: string; // hex from PALETTE
  createdAt: number;
  highlight?: { rects: NormRect[] };
  rect?: NormRect;
  draw?: { points: NormPoint[]; width: number }; // width normalized
  text?: { x: number; y: number; w: number; h: number; content: string; fontSize: number };
}

export type Op =
  | { kind: "add"; annot: Annotation }
  | { kind: "remove"; annot: Annotation }
  | { kind: "edit"; before: Annotation; after: Annotation }
  | { kind: "move"; before: Annotation; after: Annotation }
  | { kind: "resize"; before: Annotation; after: Annotation };
```

- [ ] **Step 4: Write the failing test**

Create `frontend/src/lib/annotations.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  PALETTE, normalizePoint, denormalizePoint,
  normalizeRect, denormalizeRect, rectsToNorm, newId,
} from "./annotations";

describe("PALETTE", () => {
  it("has exactly 6 colors", () => {
    expect(PALETTE).toHaveLength(6);
  });
});

describe("newId", () => {
  it("produces unique ids with a_ prefix", () => {
    expect(newId().startsWith("a_")).toBe(true);
    expect(newId()).not.toBe(newId());
  });
});

describe("normalizePoint / denormalizePoint round-trip", () => {
  const size = { w: 800, h: 1000 };
  it("round-trips a point", () => {
    const n = normalizePoint(120, 250, size);
    expect(n.x).toBeCloseTo(0.15);
    expect(n.y).toBeCloseTo(0.25);
    const p = denormalizePoint(n, size);
    expect(p.x).toBeCloseTo(120, 5);
    expect(p.y).toBeCloseTo(250, 5);
  });
  it("clamps to 0..1", () => {
    const n = normalizePoint(-50, 5000, size);
    expect(n.x).toBe(0);
    expect(n.y).toBe(1);
  });
});

describe("normalizeRect / denormalizeRect round-trip", () => {
  const size = { w: 800, h: 1000 };
  it("round-trips a rect", () => {
    const n = normalizeRect(100, 200, 300, 400, size);
    const p = denormalizeRect(n, size);
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(200, 5);
    expect(p.w).toBeCloseTo(300, 5);
    expect(p.h).toBeCloseTo(400, 5);
  });
});

describe("rectsToNorm", () => {
  const size = { w: 800, h: 1000 };
  it("converts DOMRect-like rects to normalized", () => {
    const out = rectsToNorm(
      [{ left: 80, top: 100, width: 240, height: 20 }, { left: 80, top: 120, width: 160, height: 20 }],
      size
    );
    expect(out).toHaveLength(2);
    expect(out[0].x).toBeCloseTo(0.1);
    expect(out[0].w).toBeCloseTo(0.3);
    expect(out[1].h).toBeCloseTo(0.02);
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/annotations.test.ts 2>&1 | tail -15`
Expected: FAIL — "Failed to resolve import ./annotations" (module not found).

- [ ] **Step 6: Write minimal implementation**

Create `frontend/src/lib/annotations.ts`:
```ts
import type { NormPoint, NormRect, PageSize } from "../types";

export const PALETTE = [
  "#FFEB3B", // yellow
  "#A5F3A0", // green
  "#93C5FD", // blue
  "#F9A8D4", // pink
  "#FDBA74", // orange
  "#C4B5FD", // purple
] as const;

export type PageSizeLike = PageSize;

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

export function newId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizePoint(px: number, py: number, size: PageSize): NormPoint {
  return { x: clamp01(px / size.w), y: clamp01(py / size.h) };
}

export function denormalizePoint(n: NormPoint, size: PageSize): { x: number; y: number } {
  return { x: n.x * size.w, y: n.y * size.h };
}

export function normalizeRect(px: number, py: number, pw: number, ph: number, size: PageSize): NormRect {
  return { x: clamp01(px / size.w), y: clamp01(py / size.h), w: clamp01(pw / size.w), h: clamp01(ph / size.h) };
}

export function denormalizeRect(r: NormRect, size: PageSize): { x: number; y: number; w: number; h: number } {
  return { x: r.x * size.w, y: r.y * size.h, w: r.w * size.w, h: r.h * size.h };
}

/** Convert DOMRect-like rects (relative to the page box, in px) to normalized rects. */
export function rectsToNorm(
  rects: { left: number; top: number; width: number; height: number }[],
  size: PageSize
): NormRect[] {
  return rects.map((r) => ({
    x: clamp01(r.left / size.w),
    y: clamp01(r.top / size.h),
    w: clamp01(r.width / size.w),
    h: clamp01(r.height / size.h),
  }));
}
```

Add the `PageSize` type to `frontend/src/types.ts` (append near the annotation types):
```ts
export interface PageSize { w: number; h: number; }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/annotations.test.ts 2>&1 | tail -15`
Expected: PASS — all tests pass.

- [ ] **Step 8: Typecheck + commit**

Run: `cd frontend && npm run typecheck 2>&1 | tail -5`
Expected: no output (0 errors).

```bash
cd frontend && git add package.json package-lock.json vitest.config.ts src/types.ts src/lib/annotations.ts src/lib/annotations.test.ts
git commit -m "feat: add annotation types, PALETTE, and coordinate pure functions"
```

---

### Task 2: Op-stack pure reducer (TDD)

**Files:**
- Create: `frontend/src/lib/opstack.ts`
- Create: `frontend/src/lib/opstack.test.ts`

**Interfaces:**
- Consumes: `Annotation`, `Op` from `types.ts`.
- Produces: `AnnotState`, `commit`, `undoOp`, `redoOp`, `inverse`, `applyForward`. Consumed by the zustand store (Task 4).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/opstack.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { commit, undoOp, redoOp, type AnnotState } from "./opstack";
import type { Annotation, Op } from "../types";

function mk(id: string, page: number, color = "#FFEB3B"): Annotation {
  return { id, arxiv_id: "p", page, type: "rect", color, createdAt: 1, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
}

describe("opstack", () => {
  it("commit add puts annot in array and clears redo", () => {
    const s0: AnnotState = { annots: [], undo: [], redo: [] };
    const s1 = commit(s0, { kind: "add", annot: mk("a1", 1) });
    expect(s1.annots).toHaveLength(1);
    expect(s1.annots[0].id).toBe("a1");
    expect(s1.undo).toHaveLength(1);
    expect(s1.redo).toEqual([]);
  });

  it("undo removes the annot and moves op to redo", () => {
    const s1 = commit({ annots: [], undo: [], redo: [] }, { kind: "add", annot: mk("a1", 1) });
    const s2 = undoOp(s1);
    expect(s2.annots).toHaveLength(0);
    expect(s2.undo).toHaveLength(0);
    expect(s2.redo).toHaveLength(1);
  });

  it("redo re-adds the annot", () => {
    const s1 = commit({ annots: [], undo: [], redo: [] }, { kind: "add", annot: mk("a1", 1) });
    const s2 = undoOp(s1);
    const s3 = redoOp(s2);
    expect(s3.annots).toHaveLength(1);
    expect(s3.undo).toHaveLength(1);
    expect(s3.redo).toHaveLength(0);
  });

  it("commit remove deletes by id", () => {
    const a = mk("a1", 1);
    const s1 = commit({ annots: [], undo: [], redo: [] }, { kind: "add", annot: a });
    const s2 = commit(s1, { kind: "remove", annot: a });
    expect(s2.annots).toHaveLength(0);
  });

  it("move op replaces before->after, undo restores before", () => {
    const a = mk("a1", 1);
    const s1 = commit({ annots: [], undo: [], redo: [] }, { kind: "add", annot: a });
    const moved: Annotation = { ...a, rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } };
    const s2 = commit(s1, { kind: "move", before: a, after: moved });
    expect(s2.annots[0].rect!.x).toBeCloseTo(0.5);
    const s3 = undoOp(s2);
    expect(s3.annots[0].rect!.x).toBeCloseTo(0.1);
  });

  it("a new commit clears redo stack", () => {
    const a = mk("a1", 1);
    let s = commit({ annots: [], undo: [], redo: [] }, { kind: "add", annot: a });
    s = undoOp(s); // redo has 1
    expect(s.redo).toHaveLength(1);
    const b = mk("a2", 1);
    s = commit(s, { kind: "add", annot: b });
    expect(s.redo).toHaveLength(0);
  });

  it("undoOp on empty stack is a no-op", () => {
    const s: AnnotState = { annots: [], undo: [], redo: [] };
    expect(undoOp(s)).toBe(s);
  });

  it("redoOp on empty stack is a no-op", () => {
    const s: AnnotState = { annots: [mk("a1", 1)], undo: [], redo: [] };
    expect(redoOp(s)).toBe(s);
  });

  it("cross-page: undo undoes the most recent op regardless of page", () => {
    const a1 = mk("a1", 1);
    const a3 = mk("a3", 3);
    let s = commit({ annots: [], undo: [], redo: [] }, { kind: "add", annot: a1 });
    s = commit(s, { kind: "add", annot: a3 });
    s = undoOp(s); // undoes a3 (page 3)
    expect(s.annots.map((a) => a.id)).toEqual(["a1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/opstack.test.ts 2>&1 | tail -15`
Expected: FAIL — "Failed to resolve import ./opstack".

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/opstack.ts`:
```ts
import type { Annotation, Op } from "../types";

export interface AnnotState {
  annots: Annotation[]; // flat, immutable per transition
  undo: Op[];
  redo: Op[];
}

/** Apply an op forward to the flat annotation array (returns new array). */
export function applyForward(annots: Annotation[], op: Op): Annotation[] {
  switch (op.kind) {
    case "add":
      return [...annots, op.annot];
    case "remove":
      return annots.filter((a) => a.id !== op.annot.id);
    case "edit":
    case "move":
    case "resize":
      return annots.map((a) => (a.id === op.after.id ? op.after : a));
  }
}

/** The op that undoes `op`. add<->remove; edit/move/resize swap before/after. */
export function inverse(op: Op): Op {
  switch (op.kind) {
    case "add":
      return { kind: "remove", annot: op.annot };
    case "remove":
      return { kind: "add", annot: op.annot };
    case "edit":
    case "move":
    case "resize":
      return { kind: op.kind, before: op.after, after: op.before };
  }
}

/** Commit an op forward: apply, push onto undo, clear redo. */
export function commit(state: AnnotState, op: Op): AnnotState {
  return {
    annots: applyForward(state.annots, op),
    undo: [...state.undo, op],
    redo: [],
  };
}

/** Undo the top undo op: apply its inverse, move it to redo. No-op if empty. */
export function undoOp(state: AnnotState): AnnotState {
  if (state.undo.length === 0) return state;
  const op = state.undo[state.undo.length - 1];
  return {
    annots: applyForward(state.annots, inverse(op)),
    undo: state.undo.slice(0, -1),
    redo: [...state.redo, op],
  };
}

/** Redo the top redo op: apply forward, move it to undo. No-op if empty. */
export function redoOp(state: AnnotState): AnnotState {
  if (state.redo.length === 0) return state;
  const op = state.redo[state.redo.length - 1];
  return {
    annots: applyForward(state.annots, op),
    undo: [...state.undo, op],
    redo: state.redo.slice(0, -1),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/opstack.test.ts 2>&1 | tail -15`
Expected: PASS — all tests pass.

- [ ] **Step 5: Typecheck + commit**

Run: `cd frontend && npm run typecheck 2>&1 | tail -5` → 0 errors.

```bash
cd frontend && git add src/lib/opstack.ts src/lib/opstack.test.ts
git commit -m "feat: add pure op-stack reducer for annotation undo/redo"
```

---

### Task 3: IndexedDB annotations store (DB v2)

**Files:**
- Modify: `frontend/src/lib/db.ts` (bump version, add store, add CRUD)

**Interfaces:**
- Consumes: `Annotation` from `types.ts`.
- Produces: `listAnnotations(arxivId)`, `putAnnotation(a)`, `deleteAnnotation(id)`, `clearAnnotations(arxivId)`. Consumed by the zustand store (Task 4).

- [ ] **Step 1: Modify `frontend/src/lib/db.ts`**

Replace the top of the file (lines 1-32) — change the `LaxDB` interface and `db()` to add the annotations store at version 2. Replace:
```ts
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conversation, Paper } from "../types";

interface LaxDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation;
    indexes: { "by-updated": number };
  };
  papers: {
    key: string; // arxiv_id
    value: Paper & { full_text?: string; fetched_at: number };
  };
}

let dbp: Promise<IDBPDatabase<LaxDB>> | null = null;

function db(): Promise<IDBPDatabase<LaxDB>> {
  if (!dbp) {
    dbp = openDB<LaxDB>("little-alphaxiv", 1, {
      upgrade(d) {
        const c = d.createObjectStore("conversations", { keyPath: "id" });
        c.createIndex("by-updated", "updated_at");
        d.createObjectStore("papers", { keyPath: "arxiv_id" });
      },
    });
  }
  return dbp;
}
```
with:
```ts
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conversation, Paper, Annotation } from "../types";

interface LaxDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation;
    indexes: { "by-updated": number };
  };
  papers: {
    key: string; // arxiv_id
    value: Paper & { full_text?: string; fetched_at: number };
  };
  annotations: {
    key: string; // annot.id
    value: Annotation;
    indexes: {
      "by-paper": string; // arxiv_id
      "by-paper-page": [string, number]; // [arxiv_id, page]
    };
  };
}

let dbp: Promise<IDBPDatabase<LaxDB>> | null = null;

function db(): Promise<IDBPDatabase<LaxDB>> {
  if (!dbp) {
    dbp = openDB<LaxDB>("little-alphaxiv", 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          const c = d.createObjectStore("conversations", { keyPath: "id" });
          c.createIndex("by-updated", "updated_at");
          d.createObjectStore("papers", { keyPath: "arxiv_id" });
        }
        if (oldVersion < 2) {
          const a = d.createObjectStore("annotations", { keyPath: "id" });
          a.createIndex("by-paper", "arxiv_id");
          a.createIndex("by-paper-page", ["arxiv_id", "page"]);
        }
      },
    });
  }
  return dbp;
}
```

- [ ] **Step 2: Append CRUD functions to `frontend/src/lib/db.ts`**

Append at end of file:
```ts
// ---- Annotations (per-paper PDF annotation layer) ----

export async function listAnnotations(arxivId: string): Promise<Annotation[]> {
  const d = await db();
  return d.getAllFromIndex("annotations", "by-paper", arxivId);
}

export async function putAnnotation(a: Annotation): Promise<void> {
  const d = await db();
  await d.put("annotations", a);
}

export async function deleteAnnotation(id: string): Promise<void> {
  const d = await db();
  await d.delete("annotations", id);
}

export async function clearAnnotations(arxivId: string): Promise<void> {
  const d = await db();
  const ids = await d.getAllKeysFromIndex("annotations", "by-paper", arxivId);
  const tx = d.transaction("annotations", "readwrite");
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}
```

- [ ] **Step 3: Typecheck + verify**

Run: `cd frontend && npm run typecheck 2>&1 | tail -5`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/lib/db.ts
git commit -m "feat: add annotations IndexedDB store (DB v2) with CRUD"
```

---

### Task 4: zustand annotations store

**Files:**
- Create: `frontend/src/store/annotations.ts`

**Interfaces:**
- Consumes: `opstack.ts` (`commit`/`undoOp`/`redoOp`), `db.ts` (`listAnnotations`/`putAnnotation`/`deleteAnnotation`), `annotations.ts` (`newId`), `types.ts`.
- Produces: `useAnnotations` hook with `load(arxivId)`, `addAnnot`, `removeAnnot`, `moveAnnot`, `resizeAnnot`, `editAnnot`, `undo()`, `redo()`, `setTool`, `setColor`, `toggleHighlight`, `select`, plus state `arxivId`, `annots`, `tool`, `color`, `highlightOn`, `selectedId`, `canUndo`, `canRedo`. Consumed by Tasks 5-11.

- [ ] **Step 1: Write the store**

Create `frontend/src/store/annotations.ts`:
```ts
// zustand store: flat annotation array + op-stack + IndexedDB persistence + UI state.
import { create } from "zustand";
import type { Annotation, Op, Tool } from "../types";
import { commit, undoOp, redoOp, type AnnotState } from "../lib/opstack";
import { listAnnotations, putAnnotation, deleteAnnotation } from "../lib/db";
import { newId } from "../lib/annotations";

// NOTE on naming: the op-stack (AnnotState) uses `undo: Op[]` / `redo: Op[]`
// arrays. This store exposes `undo()` / `redo()` *actions* of the same names,
// so the arrays are stored as `undoStack` / `redoStack` and converted to/from
// AnnotState at the opstack boundary (toOpState / fromOpState). Do NOT name the
// arrays `undo`/`redo` — that collides with the action methods and breaks both
// the typecheck and the reducer.
interface AnnotationUIState {
  annots: Annotation[];
  undoStack: Op[];
  redoStack: Op[];
  arxivId: string | null;
  tool: Tool;
  color: string;
  highlightOn: boolean;
  selectedId: string | null;

  load: (arxivId: string) => Promise<void>;
  addAnnot: (partial: Omit<Annotation, "id" | "arxiv_id" | "createdAt">) => void;
  removeAnnot: (id: string) => void;
  moveAnnot: (before: Annotation, after: Annotation) => void;
  resizeAnnot: (before: Annotation, after: Annotation) => void;
  editAnnot: (before: Annotation, after: Annotation) => void;
  undo: () => void;
  redo: () => void;
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  toggleHighlight: () => void;
  select: (id: string | null) => void;
}

// Bridge between the store's named arrays and the op-stack's AnnotState shape.
function toOpState(s: AnnotationUIState): AnnotState {
  return { annots: s.annots, undo: s.undoStack, redo: s.redoStack };
}
function fromOpState(n: AnnotState) {
  return { annots: n.annots, undoStack: n.undo, redoStack: n.redo };
}

// Persist the net effect of an op to IndexedDB.
function persistOp(arxivId: string, op: Op): void {
  switch (op.kind) {
    case "add":
      void putAnnotation({ ...op.annot, arxiv_id: arxivId });
      break;
    case "remove":
      void deleteAnnotation(op.annot.id);
      break;
    case "edit":
    case "move":
    case "resize":
      void putAnnotation({ ...op.after, arxiv_id: arxivId });
      break;
  }
}

export const useAnnotations = create<AnnotationUIState>((set, get) => ({
  annots: [],
  undoStack: [],
  redoStack: [],
  arxivId: null,
  tool: "none",
  color: "#FFEB3B",
  highlightOn: false,
  selectedId: null,

  load: async (arxivId) => {
    const annots = await listAnnotations(arxivId);
    set({ arxivId, annots, undoStack: [], redoStack: [], selectedId: null });
  },

  addAnnot: (partial) => {
    const { arxivId, color } = get();
    if (!arxivId) return;
    const annot: Annotation = {
      ...partial,
      id: newId(),
      arxiv_id: arxivId,
      color,
      createdAt: Date.now(),
    };
    const op: Op = { kind: "add", annot };
    persistOp(arxivId, op);
    set((s) => fromOpState(commit(toOpState(s), op)));
  },

  removeAnnot: (id) => {
    const { arxivId, annots, selectedId } = get();
    if (!arxivId) return;
    const annot = annots.find((a) => a.id === id);
    if (!annot) return;
    const op: Op = { kind: "remove", annot };
    persistOp(arxivId, op);
    set((s) => {
      const next = fromOpState(commit(toOpState(s), op));
      return { ...next, selectedId: selectedId === id ? null : selectedId };
    });
  },

  moveAnnot: (before, after) => {
    const { arxivId } = get();
    if (!arxivId) return;
    const op: Op = { kind: "move", before, after };
    persistOp(arxivId, op);
    set((s) => fromOpState(commit(toOpState(s), op)));
  },

  resizeAnnot: (before, after) => {
    const { arxivId } = get();
    if (!arxivId) return;
    const op: Op = { kind: "resize", before, after };
    persistOp(arxivId, op);
    set((s) => fromOpState(commit(toOpState(s), op)));
  },

  editAnnot: (before, after) => {
    const { arxivId } = get();
    if (!arxivId) return;
    const op: Op = { kind: "edit", before, after };
    persistOp(arxivId, op);
    set((s) => fromOpState(commit(toOpState(s), op)));
  },

  undo: () => {
    const { arxivId, undoStack } = get();
    if (!arxivId || undoStack.length === 0) return;
    const op = undoStack[undoStack.length - 1];
    // persist the inverse effect
    switch (op.kind) {
      case "add": // inverse = remove
        void deleteAnnotation(op.annot.id);
        break;
      case "remove": // inverse = add
        void putAnnotation({ ...op.annot, arxiv_id: arxivId });
        break;
      case "edit":
      case "move":
      case "resize": // inverse = restore before
        void putAnnotation({ ...op.before, arxiv_id: arxivId });
        break;
    }
    set((s) => fromOpState(undoOp(toOpState(s))));
  },

  redo: () => {
    const { arxivId, redoStack } = get();
    if (!arxivId || redoStack.length === 0) return;
    const op = redoStack[redoStack.length - 1];
    persistOp(arxivId, op);
    set((s) => fromOpState(redoOp(toOpState(s))));
  },

  setTool: (t) => set({ tool: t, selectedId: t === "none" ? get().selectedId : null }),
  setColor: (c) => set({ color: c }),
  toggleHighlight: () => set((s) => ({ highlightOn: !s.highlightOn })),
  select: (id) => set({ selectedId: id }),
}));

// Selectors
export const usePageAnnotations = (page: number) =>
  useAnnotations((s) => s.annots.filter((a) => a.page === page));

export const useCanUndo = () => useAnnotations((s) => s.undoStack.length > 0);
export const useCanRedo = () => useAnnotations((s) => s.redoStack.length > 0);
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/store/annotations.ts
git commit -m "feat: add zustand annotations store with op-stack + persistence"
```

---

### Task 5: AnnotationToolbar component

**Files:**
- Create: `frontend/src/components/AnnotationToolbar.tsx`

**Interfaces:**
- Consumes: `useAnnotations` (tool, color, highlightOn, undo, redo, canUndo, canRedo, setTool, setColor, toggleHighlight), `PALETTE`.
- Produces: `<AnnotationToolbar />`. Mounted by PdfViewer (Task 10).

- [ ] **Step 1: Write the component**

Create `frontend/src/components/AnnotationToolbar.tsx`:
```tsx
// PDF annotation toolbar: color, 4 tools, undo/redo.
// Tools: text/rect/draw are one-shot (set tool; PdfViewer resets to "none" after commit).
// highlight is a toggle (highlightOn).
import { useState } from "react";
import { useAnnotations, useCanUndo, useCanRedo } from "../store/annotations";
import { PALETTE } from "../lib/annotations";
import type { Tool } from "../types";

export function AnnotationToolbar() {
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  const highlightOn = useAnnotations((s) => s.highlightOn);
  const setTool = useAnnotations((s) => s.setTool);
  const setColor = useAnnotations((s) => s.setColor);
  const toggleHighlight = useAnnotations((s) => s.toggleHighlight);
  const undo = useAnnotations((s) => s.undo);
  const redo = useAnnotations((s) => s.redo);
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const onTool = (t: Tool) => setTool(tool === t ? "none" : t);

  return (
    <div className="annot-toolbar">
      <div className="annot-color-wrap">
        <button
          className="annot-color-btn"
          title="Color"
          style={{ background: color }}
          onClick={() => setPaletteOpen((v) => !v)}
        />
        {paletteOpen && (
          <div className="annot-palette">
            {PALETTE.map((c) => (
              <button
                key={c}
                className={"annot-swatch" + (c === color ? " selected" : "")}
                style={{ background: c }}
                onClick={() => {
                  setColor(c);
                  setPaletteOpen(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <button
        className={"annot-tool-btn" + (tool === "text" ? " active" : "")}
        title="Text"
        onClick={() => onTool("text")}
      >📝</button>
      <button
        className={"annot-tool-btn" + (tool === "rect" ? " active" : "")}
        title="Rectangle"
        onClick={() => onTool("rect")}
      >▭</button>
      <button
        className={"annot-tool-btn" + (tool === "draw" ? " active" : "")}
        title="Freehand"
        onClick={() => onTool("draw")}
      >✏️</button>
      <button
        className={"annot-tool-btn" + (highlightOn ? " active" : "")}
        title="Highlight (toggle)"
        onClick={toggleHighlight}
      >🖍️</button>

      <span className="annot-sep" />
      <button
        className="annot-tool-btn"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={undo}
      >↶</button>
      <button
        className="annot-tool-btn"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={redo}
      >↷</button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/components/AnnotationToolbar.tsx
git commit -m "feat: add AnnotationToolbar component"
```

---

### Task 6: HighlightLayer component

**Files:**
- Create: `frontend/src/components/HighlightLayer.tsx`

**Interfaces:**
- Consumes: `useAnnotations` (highlightOn, color, addAnnot, annots), `usePageAnnotations`, `rectsToNorm`, `denormalizeRect`, `PALETTE`.
- Produces: `<HighlightLayer pageNumber={n} pageSize={{w,h}} />`. Renders existing highlights below the text; when `highlightOn`, on text selection shows a color bubble and creates a highlight annot on color pick. Mounted by PdfPage (Task 10).

- [ ] **Step 1: Write the component**

Create `frontend/src/components/HighlightLayer.tsx`:
```tsx
// Highlight layer: renders highlight rects BELOW the text layer (z-index 1).
// When highlightOn, a text selection inside this page shows a color bubble;
// picking a color creates a highlight annotation from the selection's client rects.
import { useEffect, useRef, useState } from "react";
import { useAnnotations } from "../store/annotations";
import { rectsToNorm, denormalizeRect } from "../lib/annotations";
import { PALETTE } from "../lib/annotations";
import type { PageSize } from "../types";

interface Props {
  pageNumber: number;
  pageSize: PageSize;
}

interface BubblePos { x: number; y: number; }

export function HighlightLayer({ pageNumber, pageSize }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const highlightOn = useAnnotations((s) => s.highlightOn);
  const color = useAnnotations((s) => s.color);
  const addAnnot = useAnnotations((s) => s.addAnnot);
  const annots = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type === "highlight")
  );
  const [bubble, setBubble] = useState<BubblePos | null>(null);
  const pendingRectsRef = useRef<{ left: number; top: number; width: number; height: number }[] | null>(null);

  // On mouseup anywhere, if highlightOn and selection is within this page, show bubble.
  useEffect(() => {
    function onUp() {
      if (!highlightOn) return;
      const wrap = wrapRef.current;
      if (!wrap) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setBubble(null);
        pendingRectsRef.current = null;
        return;
      }
      const range = sel.getRangeAt(0);
      // The text the user selects lives in .pdf-textlayer, a SIBLING of this
      // .highlight-layer (both children of .pdf-page-canvas-wrap). So the "is this
      // selection in my page?" check must use the page container, not wrap.
      const pageWrap = wrap.parentElement; // pdf-page-canvas-wrap
      if (!pageWrap) return;
      if (!pageWrap.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== pageWrap) {
        return;
      }
      const pageRect = pageWrap.getBoundingClientRect();
      const clientRects = Array.from(range.getClientRects()).map((r) => {
        return {
          left: r.left - pageRect.left,
          top: r.top - pageRect.top,
          width: r.width,
          height: r.height,
        };
      });
      if (clientRects.length === 0) return;
      pendingRectsRef.current = clientRects;
      // place bubble above the first rect
      setBubble({ x: clientRects[0].left, y: clientRects[0].top - 32 });
    }
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [highlightOn]);

  function pickColor(c: string) {
    if (!pendingRectsRef.current) return;
    const rects = rectsToNorm(pendingRectsRef.current, pageSize);
    if (rects.length === 0) return;
    addAnnot({ type: "highlight", page: pageNumber, highlight: { rects }, color: c });
    pendingRectsRef.current = null;
    setBubble(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <div
      className="highlight-layer"
      ref={wrapRef}
      style={{ pointerEvents: highlightOn ? "auto" : "none" }}
    >
      {annots.map((a) =>
        (a.highlight?.rects ?? []).map((r, i) => {
          const p = denormalizeRect(r, pageSize);
          return (
            <div
              key={a.id + "-" + i}
              className="highlight-rect"
              style={{
                left: p.x, top: p.y, width: p.w, height: p.h,
                background: a.color,
              }}
            />
          );
        })
      )}
      {bubble && (
        <div className="highlight-bubble" style={{ left: bubble.x, top: bubble.y }}>
          {PALETTE.map((c) => (
            <button
              key={c}
              className={"highlight-bubble-swatch" + (c === color ? " selected" : "")}
              style={{ background: c }}
              onMouseDown={(e) => { e.preventDefault(); pickColor(c); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/components/HighlightLayer.tsx
git commit -m "feat: add HighlightLayer (render + create-on-select with color bubble)"
```

---

### Task 7: AnnotLayer — render existing rect/draw/text

**Files:**
- Create: `frontend/src/components/AnnotLayer.tsx` (render-only first; interaction added in Tasks 8-9)

**Interfaces:**
- Consumes: `useAnnotations` (annots for page, tool, selectedId), `denormalizeRect`, `denormalizePoint`.
- Produces: `<AnnotLayer pageNumber={n} pageSize={{w,h}} />`. This task = render only. Mounted by PdfPage (Task 10).

- [ ] **Step 1: Write the render-only component**

Create `frontend/src/components/AnnotLayer.tsx`:
```tsx
// Annotation layer ABOVE the text layer (z-index 3): rect / draw / text.
// This task renders existing annotations only. Creation + selection are added later.
import { useRef } from "react";
import { useAnnotations } from "../store/annotations";
import { denormalizeRect, denormalizePoint } from "../lib/annotations";
import type { PageSize } from "../types";

interface Props {
  pageNumber: number;
  pageSize: PageSize;
}

export function AnnotLayer({ pageNumber, pageSize }: Props) {
  const annots = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type !== "highlight")
  );
  const selectedId = useAnnotations((s) => s.selectedId);
  const layerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="annot-layer" ref={layerRef}>
      <svg
        className="annot-svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
        preserveAspectRatio="none"
      >
        {annots.map((a) => {
          if (a.type === "rect" && a.rect) {
            const p = denormalizeRect(a.rect, pageSize);
            return (
              <rect
                key={a.id}
                x={p.x} y={p.y} width={p.w} height={p.h}
                fill={a.color} fillOpacity={0.2}
                stroke={a.color} strokeWidth={1.5}
              />
            );
          }
          if (a.type === "draw" && a.draw) {
            const pts = a.draw.points
              .map((pt) => {
                const dp = denormalizePoint(pt, pageSize);
                return `${dp.x},${dp.y}`;
              })
              .join(" ");
            return (
              <polyline
                key={a.id}
                points={pts}
                fill="none"
                stroke={a.color}
                strokeWidth={a.draw.width * pageSize.w}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          }
          return null;
        })}
      </svg>

      {/* text annotations as HTML divs (sized in px) */}
      {annots
        .filter((a) => a.type === "text" && a.text)
        .map((a) => {
          const t = a.text!;
          const px = denormalizeRect({ x: t.x, y: t.y, w: t.w, h: t.h }, pageSize);
          const selected = a.id === selectedId;
          return (
            <div
              key={a.id}
              className={"annot-text" + (selected ? " selected" : "")}
              style={{
                left: px.x, top: px.y, width: px.w, minHeight: px.h,
                color: a.color,
                fontSize: t.fontSize * pageSize.w,
              }}
            >
              {t.content}
            </div>
          );
        })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/components/AnnotLayer.tsx
git commit -m "feat: add AnnotLayer render (rect/draw/text)"
```

---

### Task 8: AnnotLayer — drawing creation (rect, draw, text)

**Files:**
- Modify: `frontend/src/components/AnnotLayer.tsx`

**Interfaces:**
- Consumes: `useAnnotations` (tool, color, addAnnot, setTool), `normalizePoint`, `normalizeRect`.
- Produces: same `<AnnotLayer />` now handles pointer-driven creation for rect/draw/text and resets tool to `"none"` after a one-shot commit.

- [ ] **Step 1: Replace the component with creation-capable version**

Replace the entire contents of `frontend/src/components/AnnotLayer.tsx` with:
```tsx
// Annotation layer ABOVE the text layer (z-index 3): rect / draw / text.
// Renders existing annotations AND handles one-shot creation:
//   tool==="rect"  -> drag to draw a rectangle
//   tool==="draw"  -> drag to draw freehand
//   tool==="text"  -> click to place an editable text box
// After commit the tool resets to "none" (one-shot).
import { useRef, useState } from "react";
import { useAnnotations } from "../store/annotations";
import {
  denormalizeRect, denormalizePoint, normalizePoint, normalizeRect,
} from "../lib/annotations";
import type { PageSize, NormPoint } from "../types";

interface Props {
  pageNumber: number;
  pageSize: PageSize;
}

const MIN_SIZE = 0.0075; // ~6px on an 800px page; discard smaller

export function AnnotLayer({ pageNumber, pageSize }: Props) {
  const annots = useAnnotations((s) =>
    s.annots.filter((a) => a.page === pageNumber && a.type !== "highlight")
  );
  const selectedId = useAnnotations((s) => s.selectedId);
  const tool = useAnnotations((s) => s.tool);
  const color = useAnnotations((s) => s.color);
  const addAnnot = useAnnotations((s) => s.addAnnot);
  const setTool = useAnnotations((s) => s.setTool);
  const select = useAnnotations((s) => s.select);
  const layerRef = useRef<HTMLDivElement>(null);

  // in-progress creation state
  const [draftRect, setDraftRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[]>([]);
  const [textBox, setTextBox] = useState<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);

  function toLayerPx(e: React.PointerEvent): { x: number; y: number } {
    const rect = layerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (tool === "rect") {
      drawingRef.current = true;
      (e.target as Element).setPointerCapture(e.pointerId);
      const p = toLayerPx(e);
      setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 });
    } else if (tool === "draw") {
      drawingRef.current = true;
      (e.target as Element).setPointerCapture(e.pointerId);
      setDraftPoints([toLayerPx(e)]);
    } else if (tool === "text") {
      const p = toLayerPx(e);
      setTextBox({ x: p.x, y: p.y });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drawingRef.current) return;
    const p = toLayerPx(e);
    if (tool === "rect" && draftRect) {
      setDraftRect({ x: draftRect.x, y: draftRect.y, w: p.x - draftRect.x, h: p.y - draftRect.y });
    } else if (tool === "draw") {
      setDraftPoints((pts) => [...pts, p]);
    }
  }

  function onPointerUp() {
    if (tool === "rect" && draftRect) {
      // Canonicalize the px rect BEFORE normalizeRect: dragging up/left yields
      // negative w/h, and normalizeRect clamps w/h to [0,1] via clamp01 — which
      // would zero out a negative width and silently drop the annotation.
      const px = {
        x: draftRect.w < 0 ? draftRect.x + draftRect.w : draftRect.x,
        y: draftRect.h < 0 ? draftRect.y + draftRect.h : draftRect.y,
        w: Math.abs(draftRect.w),
        h: Math.abs(draftRect.h),
      };
      const r = normalizeRect(px.x, px.y, px.w, px.h, pageSize);
      if (r.w >= MIN_SIZE && r.h >= MIN_SIZE) {
        addAnnot({ type: "rect", page: pageNumber, rect: r, color });
      }
      setDraftRect(null);
      setTool("none");
    } else if (tool === "draw" && draftPoints.length > 1) {
      const pts: NormPoint[] = draftPoints.map((p) => normalizePoint(p.x, p.y, pageSize));
      addAnnot({ type: "draw", page: pageNumber, draw: { points: pts, width: 0.0025 }, color });
      setDraftPoints([]);
      setTool("none");
    }
    drawingRef.current = false;
  }

  function commitText(content: string, boxPx: { x: number; y: number; w: number; h: number }) {
    const trimmed = content.trim();
    if (trimmed) {
      const r = normalizeRect(boxPx.x, boxPx.y, boxPx.w, boxPx.h, pageSize);
      addAnnot({
        type: "text", page: pageNumber,
        text: { x: r.x, y: r.y, w: r.w, h: r.h, content: trimmed, fontSize: 0.0175 },
        color,
      });
    }
    setTextBox(null);
    setTool("none");
  }

  const interactive = tool === "rect" || tool === "draw" || tool === "text";

  return (
    <div
      className="annot-layer"
      ref={layerRef}
      style={{ pointerEvents: interactive ? "auto" : "none", cursor: tool === "text" ? "text" : interactive ? "crosshair" : "default" }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
    >
      <svg
        className="annot-svg"
        width="100%" height="100%"
        viewBox={`0 0 ${pageSize.w} ${pageSize.h}`}
        preserveAspectRatio="none"
      >
        {annots.map((a) => {
          if (a.type === "rect" && a.rect) {
            const p = denormalizeRect(a.rect, pageSize);
            return <rect key={a.id} x={p.x} y={p.y} width={p.w} height={p.h} fill={a.color} fillOpacity={0.2} stroke={a.color} strokeWidth={1.5} />;
          }
          if (a.type === "draw" && a.draw) {
            const pts = a.draw.points.map((pt) => { const dp = denormalizePoint(pt, pageSize); return `${dp.x},${dp.y}`; }).join(" ");
            return <polyline key={a.id} points={pts} fill="none" stroke={a.color} strokeWidth={a.draw.width * pageSize.w} strokeLinejoin="round" strokeLinecap="round" />;
          }
          return null;
        })}
        {/* draft rect */}
        {draftRect && (
          <rect
            x={draftRect.x} y={draftRect.y} width={draftRect.w} height={draftRect.h}
            fill={color} fillOpacity={0.2} stroke={color} strokeWidth={1.5}
          />
        )}
        {/* draft polyline */}
        {draftPoints.length > 1 && (
          <polyline
            points={draftPoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          />
        )}
      </svg>

      {annots.filter((a) => a.type === "text" && a.text).map((a) => {
        const t = a.text!;
        const px = denormalizeRect({ x: t.x, y: t.y, w: t.w, h: t.h }, pageSize);
        const selected = a.id === selectedId;
        return (
          <div key={a.id} className={"annot-text" + (selected ? " selected" : "")}
            style={{ left: px.x, top: px.y, width: px.w, minHeight: px.h, color: a.color, fontSize: t.fontSize * pageSize.w }}
            onPointerDown={() => { if (tool === "none") select(a.id); }}
          >
            {t.content}
          </div>
        );
      })}

      {/* text input box */}
      {textBox && (
        <TextInputBox
          x={textBox.x} y={textBox.y} color={color}
          onCommit={(content, boxPx) => commitText(content, boxPx)}
          onCancel={() => { setTextBox(null); setTool("none"); }}
        />
      )}
    </div>
  );
}

function TextInputBox({
  x, y, color, onCommit, onCancel,
}: {
  x: number; y: number; color: string;
  onCommit: (content: string, boxPx: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [val, setVal] = useState("");
  // focus on mount
  if (ref.current && document.activeElement !== ref.current) {
    setTimeout(() => ref.current?.focus(), 0);
  }
  function finish() {
    const el = ref.current;
    const w = el?.offsetWidth ?? 120;
    const h = el?.offsetHeight ?? 24;
    onCommit(val, { x, y, w, h });
  }
  return (
    <textarea
      ref={ref}
      className="annot-text-input"
      value={val}
      style={{ left: x, top: y, color }}
      onChange={(e) => setVal(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(); }
        if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      }}
      rows={1}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/components/AnnotLayer.tsx
git commit -m "feat: AnnotLayer creation (rect/draw/text one-shot tools)"
```

---

### Task 9: AnnotLayer — selection / move / resize / delete

**Files:**
- Modify: `frontend/src/components/AnnotLayer.tsx`

**Interfaces:**
- Consumes: `useAnnotations` (selectedId, select, moveAnnot, resizeAnnot, removeAnnot).
- Produces: same `<AnnotLayer />` now supports click-to-select, drag-body move, drag-handle resize, Delete key to remove. Highlights are excluded (not selectable for move/resize).

- [ ] **Step 1: Add selection + move/resize logic**

Add these imports to the top of `frontend/src/components/AnnotLayer.tsx` (merge into the existing import from `"../store/annotations"` and `"./annotations"`):
```tsx
// add to store import:
select, moveAnnot, resizeAnnot, removeAnnot,
// add to annotations import:
import { denormalizeRect, denormalizePoint, normalizePoint, normalizeRect } from "../lib/annotations";
```
(These names are already imported; just ensure `moveAnnot`, `resizeAnnot`, `removeAnnot` are added to the `useAnnotations` destructure below.)

Add to the `useAnnotations` destructures inside `AnnotLayer` (after `select`):
```tsx
  const moveAnnot = useAnnotations((s) => s.moveAnnot);
  const resizeAnnot = useAnnotations((s) => s.resizeAnnot);
  const removeAnnot = useAnnotations((s) => s.removeAnnot);
```

Add a `dragRef` near the other refs (after `drawingRef`):
```tsx
  // selection drag state
  const dragRef = useRef<
    | { mode: "move"; annot: Annotation; startPx: { x: number; y: number }; orig: Annotation }
    | { mode: "resize"; annot: Annotation; handle: string; startPx: { x: number; y: number }; orig: Annotation }
    | null
  >(null);
  const [dragPreview, setDragPreview] = useState<Annotation | null>(null);
```

Add the `Annotation` type to the imports from `"../types"`:
```tsx
import type { PageSize, NormPoint, Annotation } from "../types";
```

Add these handler functions inside `AnnotLayer` (after `commitText`):
```tsx
  // ---- selection / move / resize (tool === "none") ----
  function startMove(e: React.PointerEvent, a: Annotation) {
    if (tool !== "none") return;
    e.stopPropagation();
    select(a.id);
    const p = toLayerPx(e);
    dragRef.current = { mode: "move", annot: a, startPx: p, orig: a };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function startResize(e: React.PointerEvent, a: Annotation, handle: string) {
    if (tool !== "none") return;
    e.stopPropagation();
    const p = toLayerPx(e);
    dragRef.current = { mode: "resize", annot: a, handle, startPx: p, orig: a };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const p = toLayerPx(e);
    const dxN = (p.x - d.startPx.x) / pageSize.w;
    const dyN = (p.y - d.startPx.y) / pageSize.h;
    if (d.mode === "move") {
      setDragPreview(moveAnnotGeom(d.orig, dxN, dyN));
    } else {
      setDragPreview(resizeAnnotGeom(d.orig, d.handle, dxN, dyN));
    }
  }

  function onDragUp() {
    const d = dragRef.current;
    if (!d) return;
    const preview = dragPreview ?? d.orig;
    if (d.mode === "move") moveAnnot(d.orig, preview);
    else resizeAnnot(d.orig, preview);
    dragRef.current = null;
    setDragPreview(null);
  }
```

Add the geometry helpers as module-level functions at the BOTTOM of `AnnotLayer.tsx` (after `TextInputBox`):
```tsx
// Move an annotation's geometry by normalized delta.
function moveAnnotGeom(a: Annotation, dxN: number, dyN: number): Annotation {
  if (a.type === "rect" && a.rect) {
    return { ...a, rect: { ...a.rect, x: a.rect.x + dxN, y: a.rect.y + dyN } };
  }
  if (a.type === "draw" && a.draw) {
    return { ...a, draw: { ...a.draw, points: a.draw.points.map((p) => ({ x: p.x + dxN, y: p.y + dyN })) } };
  }
  if (a.type === "text" && a.text) {
    return { ...a, text: { ...a.text, x: a.text.x + dxN, y: a.text.y + dyN } };
  }
  return a;
}

// Resize by handle. handle in {nw,n,ne,e,se,s,sw,w}. For draw, scale the bounding box.
function resizeAnnotGeom(a: Annotation, handle: string, dxN: number, dyN: number): Annotation {
  if (a.type === "rect" && a.rect) {
    return { ...a, rect: resizeRect(a.rect, handle, dxN, dyN) };
  }
  if (a.type === "text" && a.text) {
    const r = resizeRect({ x: a.text.x, y: a.text.y, w: a.text.w, h: a.text.h }, handle, dxN, dyN);
    // scale font with width
    const scale = a.text.w > 0 ? r.w / a.text.w : 1;
    return { ...a, text: { ...a.text, x: r.x, y: r.y, w: r.w, h: r.h, fontSize: a.text.fontSize * scale, content: a.text.content } };
  }
  if (a.type === "draw" && a.draw) {
    const bbox = bboxOf(a.draw.points);
    const r = resizeRect(bbox, handle, dxN, dyN);
    return { ...a, draw: { ...a.draw, points: rescalePoints(a.draw.points, bbox, r) } };
  }
  return a;
}

function resizeRect(r: { x: number; y: number; w: number; h: number }, handle: string, dxN: number, dyN: number) {
  let { x, y, w, h } = r;
  if (handle.includes("w")) { x += dxN; w -= dxN; }
  if (handle.includes("e")) { w += dxN; }
  if (handle.includes("n")) { y += dyN; h -= dyN; }
  if (handle.includes("s")) { h += dyN; }
  return { x, y, w: Math.max(0.01, w), h: Math.max(0.01, h) };
}

function bboxOf(points: { x: number; y: number }[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, w: Math.max(0.001, maxX - minX), h: Math.max(0.001, maxY - minY) };
}

function rescalePoints(points: { x: number; y: number }[], oldBox: { x: number; y: number; w: number; h: number }, newBox: { x: number; y: number; w: number; h: number }) {
  const sx = newBox.w / oldBox.w;
  const sy = newBox.h / oldBox.h;
  return points.map((p) => ({ x: newBox.x + (p.x - oldBox.x) * sx, y: newBox.y + (p.y - oldBox.y) * sy }));
}
```

- [ ] **Step 2: Wire drag handlers + selection UI into the render**

In the JSX, attach drag handlers to the layer div. Replace the opening `<div className="annot-layer" ...>` line's handlers — keep `onPointerDown/Move/Up` for creation but add move/up for drag. Modify the `<div>` to:
```tsx
    <div
      className="annot-layer"
      ref={layerRef}
      style={{ pointerEvents: interactive ? "auto" : "none", cursor: tool === "text" ? "text" : interactive ? "crosshair" : "default" }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : onDragMove}
      onPointerUp={interactive ? onPointerUp : onDragUp}
    >
```

Replace the existing rendered-annotation `<svg>` `map` block (the one rendering committed annots inside the svg) so it renders `dragPreview ?? a` when that annot is being dragged. Replace:
```tsx
        {annots.map((a) => {
          if (a.type === "rect" && a.rect) {
            const p = denormalizeRect(a.rect, pageSize);
            return <rect key={a.id} x={p.x} y={p.y} width={p.w} height={p.h} fill={a.color} fillOpacity={0.2} stroke={a.color} strokeWidth={1.5} />;
          }
          if (a.type === "draw" && a.draw) {
            const pts = a.draw.points.map((pt) => { const dp = denormalizePoint(pt, pageSize); return `${dp.x},${dp.y}`; }).join(" ");
            return <polyline key={a.id} points={pts} fill="none" stroke={a.color} strokeWidth={a.draw.width * pageSize.w} strokeLinejoin="round" strokeLinecap="round" />;
          }
          return null;
        })}
```
with:
```tsx
        {annots.map((a) => {
          const cur = dragPreview && dragPreview.id === a.id ? dragPreview : a;
          if (cur.type === "rect" && cur.rect) {
            const p = denormalizeRect(cur.rect, pageSize);
            return (
              <g key={a.id}>
                <rect
                  x={p.x} y={p.y} width={p.w} height={p.h}
                  fill={a.color} fillOpacity={0.2} stroke={a.color} strokeWidth={1.5}
                  style={{ pointerEvents: tool === "none" ? "stroke" : "none", cursor: tool === "none" ? "move" : "default" }}
                  onPointerDown={(e) => startMove(e, a)}
                />
                {selectedId === a.id && tool === "none" && (
                  <SelectionHandles rect={p} onHandleDown={(h, e) => startResize(e, a, h)} />
                )}
              </g>
            );
          }
          if (cur.type === "draw" && cur.draw) {
            const pts = cur.draw.points.map((pt) => { const dp = denormalizePoint(pt, pageSize); return `${dp.x},${dp.y}`; }).join(" ");
            const bbox = denormalizeRect(bboxOf(cur.draw.points), pageSize);
            return (
              <g key={a.id}>
                <polyline
                  points={pts} fill="none" stroke={a.color}
                  strokeWidth={cur.draw.width * pageSize.w} strokeLinejoin="round" strokeLinecap="round"
                  style={{ pointerEvents: tool === "none" ? "stroke" : "none", cursor: tool === "none" ? "move" : "default" }}
                  onPointerDown={(e) => startMove(e, a)}
                />
                {selectedId === a.id && tool === "none" && (
                  <SelectionHandles rect={bbox} onHandleDown={(h, e) => startResize(e, a, h)} />
                )}
              </g>
            );
          }
          return null;
        })}
```

Replace the text-annotation render block (the `annots.filter(... text ...).map`) so it also uses `dragPreview`:
```tsx
      {annots.filter((a) => a.type === "text" && a.text).map((a) => {
        const cur = dragPreview && dragPreview.id === a.id ? dragPreview : a;
        const t = cur.text!;
        const px = denormalizeRect({ x: t.x, y: t.y, w: t.w, h: t.h }, pageSize);
        const selected = a.id === selectedId;
        return (
          <div
            key={a.id}
            className={"annot-text" + (selected ? " selected" : "")}
            style={{ left: px.x, top: px.y, width: px.w, minHeight: px.h, color: a.color, fontSize: t.fontSize * pageSize.w, cursor: tool === "none" ? "move" : "default" }}
            onPointerDown={(e) => { if (tool === "none") startMove(e, a); }}
          >
            {t.content}
          </div>
        );
      })}
```

Add the `SelectionHandles` component at the bottom of the file:
```tsx
function SelectionHandles({
  rect, onHandleDown,
}: {
  rect: { x: number; y: number; w: number; h: number };
  onHandleDown: (handle: string, e: React.PointerEvent) => void;
}) {
  const hs = 8;
  const handles: [string, number, number][] = [
    ["nw", rect.x, rect.y],
    ["n", rect.x + rect.w / 2, rect.y],
    ["ne", rect.x + rect.w, rect.y],
    ["e", rect.x + rect.w, rect.y + rect.h / 2],
    ["se", rect.x + rect.w, rect.y + rect.h],
    ["s", rect.x + rect.w / 2, rect.y + rect.h],
    ["sw", rect.x, rect.y + rect.h],
    ["w", rect.x, rect.y + rect.h / 2],
  ];
  return (
    <>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill="none" stroke="var(--accent)" strokeWidth={1} strokeDasharray="3 2" />
      {handles.map(([h, hx, hy]) => (
        <rect
          key={h}
          x={hx - hs / 2} y={hy - hs / 2} width={hs} height={hs}
          fill="#fff" stroke="var(--accent)" strokeWidth={1}
          style={{ cursor: "pointer" }}
          onPointerDown={(e) => onHandleDown(h, e)}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/components/AnnotLayer.tsx
git commit -m "feat: AnnotLayer selection, move, resize, delete (handles)"
```

> Note: Delete-key handling is wired in Task 10 (PdfViewer keydown) since it must act only when an annotation is selected and not when typing in chat. `removeAnnot(selectedId)` is the call.

---

### Task 10: Integrate layers into PdfPage + toolbar + keyboard shortcuts

**Files:**
- Modify: `frontend/src/components/PdfViewer.tsx`

**Interfaces:**
- Consumes: `AnnotationToolbar`, `HighlightLayer`, `AnnotLayer`, `useAnnotations`.
- Produces: `PdfViewer` shows the toolbar; each `PdfPage` renders `HighlightLayer` + `AnnotLayer` above its textlayer, sized to the current viewport; ESC + Ctrl+Z/Ctrl+Shift+Z + Delete handled; pointer-events toggle by tool.

- [ ] **Step 1: Add imports + pageSize state to `PdfPage`**

In `frontend/src/components/PdfViewer.tsx`, add imports near the top (after the existing imports):
```tsx
import { AnnotationToolbar } from "./AnnotationToolbar";
import { HighlightLayer } from "./HighlightLayer";
import { AnnotLayer } from "./AnnotLayer";
import { useAnnotations } from "../store/annotations";
import type { PageSize } from "../types";
```

Inside the `PdfPage` component, replace the `viewportSizeRef` line:
```tsx
  const viewportSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  void viewportSizeRef;
```
with a state hook the layers can read:
```tsx
  const [pageSize, setPageSize] = useState<PageSize>({ w: 0, h: 0 });
```

- [ ] **Step 2: Set pageSize in the render effect**

In the render `useEffect` of `PdfPage`, replace:
```tsx
      viewportSizeRef.current = { w: viewport.width, h: viewport.height };
```
with:
```tsx
      setPageSize({ w: viewport.width, h: viewport.height });
```

- [ ] **Step 3: Render the layers in `PdfPage`'s JSX**

Replace the `PdfPage` return block:
```tsx
  return (
    <div className="pdf-page-wrap" ref={wrapRef}>
      <div className="pdf-page-canvas-wrap" style={{ minHeight: rendered ? undefined : 1000 }}>
        <canvas ref={canvasRef} />
        <div className="pdf-textlayer" ref={textLayerRef} />
      </div>
    </div>
  );
```
with:
```tsx
  return (
    <div className="pdf-page-wrap" ref={wrapRef}>
      <div className="pdf-page-canvas-wrap" style={{ minHeight: rendered ? undefined : 1000 }}>
        <canvas ref={canvasRef} />
        <HighlightLayer pageNumber={pageNumber} pageSize={pageSize} />
        <div className="pdf-textlayer" ref={textLayerRef} />
        <AnnotLayer pageNumber={pageNumber} pageSize={pageSize} />
      </div>
    </div>
  );
```

- [ ] **Step 4: Mount the toolbar in `PdfViewer` + keyboard shortcuts**

In the `PdfViewer` component's return, replace the toolbar block:
```tsx
      <div className="pdf-toolbar">
        <button onClick={zoomOut} title="Zoom out">−</button>
        <button onClick={fitWidth} title="Fit width" className="zoom-pct">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={zoomIn} title="Zoom in">+</button>
        <span className="pdf-pagecount">{numPages ? `${numPages} pages` : "…"}</span>
      </div>
```
with:
```tsx
      <div className="pdf-toolbar">
        <button onClick={zoomOut} title="Zoom out">−</button>
        <button onClick={fitWidth} title="Fit width" className="zoom-pct">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={zoomIn} title="Zoom in">+</button>
        <AnnotationToolbar />
        <span className="pdf-pagecount">{numPages ? `${numPages} pages` : "…"}</span>
      </div>
```

Add a keyboard-shortcut `useEffect` inside the `PdfViewer` component (after the `fitWidth` useCallback, before the `return`):
```tsx
  // Annotation keyboard shortcuts: undo / redo / delete / esc.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      // ignore when typing in an input/textarea/contenteditable (chat or text annot)
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useAnnotations.getState().redo();
        else useAnnotations.getState().undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        useAnnotations.getState().redo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace")) {
        const s = useAnnotations.getState();
        if (s.selectedId) { e.preventDefault(); s.removeAnnot(s.selectedId); }
        return;
      }
      if (e.key === "Escape") {
        const s = useAnnotations.getState();
        // priority: clear text selection; clear selection; (highlight toggle stays)
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) { sel.removeAllRanges(); return; }
        if (s.selectedId) { s.select(null); return; }
        if (s.tool !== "none") { s.setTool("none"); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
```

Add `useEffect` to the existing React import if not present — the file already imports `useEffect, useRef, useState, useCallback` from `"react"`, so no import change needed.

- [ ] **Step 5: Typecheck + manual smoke**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

Manual smoke (dev server): `cd frontend && npm run dev` then open a paper. Verify: toolbar appears; drawing a rect leaves a colored box; freehand draws a line; text tool places an editable box; highlight toggle + select text shows a bubble. (Persistence + reload verified in Task 11.)

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/components/PdfViewer.tsx
git commit -m "feat: integrate annotation layers + toolbar + shortcuts into PdfViewer"
```

---

### Task 11: Load annotations in PaperView

**Files:**
- Modify: `frontend/src/views/PaperView.tsx`

**Interfaces:**
- Consumes: `useAnnotations` (`load`).
- Produces: on paper open, the store is loaded with persisted annotations for that arxiv_id.

- [ ] **Step 1: Wire load on arxivId change**

In `frontend/src/views/PaperView.tsx`, add the import (near the other store imports):
```tsx
import { useAnnotations } from "../store/annotations";
```

Add a `useEffect` inside the `PaperView` component (after the existing `useEffect` that loads full text, around line 48):
```tsx
  const loadAnnots = useAnnotations((s) => s.load);
  useEffect(() => {
    if (!arxivId) return;
    loadAnnots(arxivId);
  }, [arxivId, loadAnnots]);
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 3: Manual verify persistence**

Run dev server, open a paper, draw a rect + a highlight, **reload the page** — annotations must reappear at the same positions. Undo/redo must work across reload (undo stack resets on reload, which is acceptable; persisted annots reload).

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/views/PaperView.tsx
git commit -m "feat: load persisted annotations into store on paper open"
```

---

### Task 12: Code-block syntax highlighting (highlight.js)

**Files:**
- Modify: `frontend/package.json` (add `highlight.js`)
- Create: `frontend/src/components/CodeBlock.tsx`
- Modify: `frontend/src/components/ChatPanel.tsx`

**Interfaces:**
- Consumes: `highlight.js`.
- Produces: `<CodeBlock />` used as react-markdown's `code` renderer; wired into all 3 ReactMarkdown usages.

- [ ] **Step 1: Install highlight.js**

Run:
```bash
cd frontend && npm install highlight.js@^11.9.0 2>&1 | tail -3
```
Expected: `added N packages`, no error.

- [ ] **Step 2: Create CodeBlock component**

Create `frontend/src/components/CodeBlock.tsx`:
```tsx
// Markdown code renderer: syntax-highlight fenced code blocks with highlight.js.
// react-markdown v10 does NOT pass an `inline` prop to the `code` component
// (removed after v8), and it wraps block code in its own <pre>. So we override
// BOTH `pre` (adds copy button + .code-block wrapper) and `code` (highlights
// block code, leaves inline code plain). Block-vs-inline is detected in `code`
// via: has a language- class OR contains a newline (inline backtick code is
// always single-line with no language class). This avoids (a) misdetecting
// inline code as a block and (b) nesting a <pre> inside react-markdown's outer <pre>.
import { useMemo, useRef, useState } from "react";
import hljs from "highlight.js";

interface CodeProps {
  className?: string;
  children?: React.ReactNode;
}

export function CodeBlock({ className, children }: CodeProps) {
  const raw = String(children ?? "");
  const code = raw.replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className || "")?.[1];
  const isBlock = !!lang || raw.includes("\n");

  const html = useMemo(() => {
    if (!isBlock || !code) return null;
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [isBlock, code, lang]);

  if (!isBlock) {
    return <code className={className}>{children}</code>;
  }
  return (
    <code
      className={lang ? `hljs language-${lang}` : "hljs"}
      dangerouslySetInnerHTML={html ? { __html: html } : undefined}
    >
      {html ? undefined : code}
    </code>
  );
}

interface PreProps {
  children?: React.ReactNode;
}

export function CodePre({ children }: PreProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  function copy() {
    const text = preRef.current?.textContent ?? "";
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="code-block">
      <button className="code-block-copy" onClick={copy} title="Copy">
        {copied ? "✓" : "⧉"}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

export const markdownCodeComponents = { code: CodeBlock, pre: CodePre };
```

- [ ] **Step 3: Wire into ChatPanel's 3 ReactMarkdown usages**

In `frontend/src/components/ChatPanel.tsx`, add the import (after the existing component imports):
```tsx
import { markdownCodeComponents } from "./CodeBlock";
```

Add the `components` prop to all three `<ReactMarkdown ...>` usages (lines ~205, ~211, ~304). For each, change:
```tsx
<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{...}</ReactMarkdown>
```
to:
```tsx
<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={markdownCodeComponents}>{...}</ReactMarkdown>
```
(All three get the same `components={markdownCodeComponents}` added before the `>`.)

- [ ] **Step 4: Import the highlight.js theme CSS**

In `frontend/src/main.tsx`, add (so the github-dark theme loads once globally):
```tsx
import "highlight.js/styles/github-dark.css";
```
(Add after the existing `import "./index.css";` line.)

- [ ] **Step 5: Typecheck + manual smoke**

Run: `cd frontend && npm run typecheck 2>&1 | tail -10`
Expected: 0 errors.

Manual smoke: dev server → ask the assistant to "show me a python snippet" (or paste a fenced ```python block) → code block renders highlighted with a copy button.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add package.json package-lock.json src/components/CodeBlock.tsx src/components/ChatPanel.tsx src/main.tsx
git commit -m "feat: highlight.js code-block highlighting + copy button in chat"
```

---

### Task 13: CSS (append styles for layers, toolbar, code block)

**Files:**
- Modify: `frontend/src/index.css` (APPEND only)

- [ ] **Step 1: Append all annotation + code-block CSS**

Append the following to the END of `frontend/src/index.css` (do not modify any existing line):
```css

/* ---------- PDF annotation layers (appended) ---------- */
.highlight-layer {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  z-index: 1; pointer-events: none;
}
.highlight-rect {
  position: absolute; opacity: 0.35; mix-blend-mode: multiply;
  pointer-events: none;
}
.highlight-bubble {
  position: absolute; z-index: 5; display: flex; gap: 4px;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.highlight-bubble-swatch {
  width: 18px; height: 18px; border-radius: 4px; border: 2px solid transparent;
  cursor: pointer; padding: 0;
}
.highlight-bubble-swatch.selected { border-color: var(--text); }

.annot-layer {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  z-index: 3; pointer-events: none;
}
.annot-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.annot-text {
  position: absolute; padding: 2px 4px; line-height: 1.3;
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  white-space: pre-wrap; word-break: break-word;
}
.annot-text.selected { outline: 1px dashed var(--accent); }
.annot-text-input {
  position: absolute; min-width: 80px; min-height: 24px;
  padding: 2px 4px; background: rgba(255,255,255,0.95); color: #000;
  border: 1px solid var(--accent); border-radius: 3px;
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 14px;
  resize: both; outline: none;
}

/* annotation toolbar (appended) */
.annot-toolbar { display: flex; align-items: center; gap: 4px; margin-left: 8px; }
.annot-color-wrap { position: relative; }
.annot-color-btn {
  width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--border);
  cursor: pointer; padding: 0;
}
.annot-palette {
  position: absolute; top: 28px; left: 0; z-index: 10;
  display: flex; gap: 4px; background: var(--bg-3);
  border: 1px solid var(--border); border-radius: 6px; padding: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.annot-swatch {
  width: 18px; height: 18px; border-radius: 4px; border: 2px solid transparent;
  cursor: pointer; padding: 0;
}
.annot-swatch.selected { border-color: var(--text); }
.annot-tool-btn {
  border: none; background: var(--bg-3); color: var(--text);
  min-width: 28px; height: 26px; border-radius: 5px; cursor: pointer;
  font-size: 14px; padding: 0 6px;
}
.annot-tool-btn:hover { background: var(--border); }
.annot-tool-btn.active { border: 1px solid var(--accent); color: var(--accent); }
.annot-tool-btn:disabled { opacity: 0.4; cursor: default; }
.annot-sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; }

/* code block (appended) */
.code-block { position: relative; margin: 8px 0; }
.code-block-copy {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  border: none; background: rgba(255,255,255,0.1); color: var(--text);
  border-radius: 4px; cursor: pointer; font-size: 12px; padding: 2px 6px;
  opacity: 0; transition: opacity 0.15s;
}
.code-block:hover .code-block-copy { opacity: 1; }
.code-block pre {
  margin: 0; padding: 12px; overflow-x: auto;
  background: #0d1117; border-radius: 6px; font-size: 13px; line-height: 1.5;
}
.code-block code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
/* override github-dark.css `pre code.hljs { padding: 1em }` so the code isn't double-padded (the .code-block pre already has 12px) */
.code-block pre code.hljs { padding: 0; background: transparent; }
```

- [ ] **Step 2: Typecheck + manual verify**

Run: `cd frontend && npm run typecheck 2>&1 | tail -5`
Expected: 0 errors.

Manual verify: dev server → annotations render with correct colors/handles; code blocks show dark theme + hover copy button.

- [ ] **Step 3: Commit**

```bash
cd frontend && git add src/index.css
git commit -m "feat: append annotation layer + code-block CSS"
```

---

### Task 14: Final verification

- [ ] **Step 1: Run full test + typecheck**

Run:
```bash
cd frontend && npm run typecheck && npm test 2>&1 | tail -20
```
Expected: typecheck 0 errors; vitest all pass (annotations + opstack suites).

- [ ] **Step 2: Manual E2E checklist**

Dev server, open a paper, verify each:
- [ ] Draw a rectangle → colored box appears
- [ ] Draw freehand → line appears
- [ ] Text tool → click → type → Enter → text persists
- [ ] Highlight toggle on → select text → bubble → pick color → text highlighted
- [ ] Click an annotation → 8 handles appear
- [ ] Drag body → moves; drag handle → resizes
- [ ] Select + Delete → removed
- [ ] Ctrl+Z / Ctrl+Shift+Z → undo/redo across pages
- [ ] ESC → clears selection / in-progress / text selection
- [ ] Reload page → all annotations persist in place
- [ ] Zoom in/out → annotations stay aligned (normalized coords)
- [ ] Ask assistant for a code snippet → highlighted with copy button

- [ ] **Step 3: Final commit if any fixes needed**

If fixes were needed during verification, commit them. Otherwise this task produces no commit.

---

## Self-Review Notes

- **Spec coverage:** Layer structure (§3) → Task 6,7,10; data model (§4) → Task 1; toolbar/interaction (§5) → Task 5,8,10; selection/move/resize/delete (§6) → Task 9,10; undo/redo (§7) → Task 2,4; persistence (§8) → Task 3,4,11; code highlight (§9) → Task 12; CSS → Task 13; testing (§13) → Tasks 1,2 + Task 14. All spec sections covered.
- **Placeholder scan:** none; every code step has full code.
- **Type consistency:** `Annotation`/`Op`/`NormRect`/`NormPoint`/`Tool`/`PageSize` defined in Task 1, used consistently through Task 11. Store action names (`addAnnot`/`removeAnnot`/`moveAnnot`/`resizeAnnot`/`editAnnot`/`undo`/`redo`/`setTool`/`setColor`/`toggleHighlight`/`select`) match across Tasks 4,5,6,8,9,10.
- **Known simplification:** Undo stack resets on page reload (only persisted annots reload). This matches spec §8 (persistence of annots, not of in-memory undo stack) and is acceptable.
