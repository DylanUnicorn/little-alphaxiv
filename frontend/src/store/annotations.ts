// zustand store: flat annotation array + op-stack + server persistence + UI state.
import { create } from "zustand";
import type { Annotation, NormPoint, Op, Tool } from "../types";
import { commit, undoOp, redoOp, type AnnotState } from "../lib/opstack";
import * as api from "../lib/api";
import { newId, migrateAnnotation } from "../lib/annotations";

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
  // Freehand session: maps page -> block annotation id currently being appended
  // to. The first stroke of a session creates the block (add op); subsequent
  // strokes append (edit op). Cleared when leaving the draw tool.
  drawSession: Record<number, string>;
  addDrawStroke: (page: number, stroke: NormPoint[], color: string, width: number) => void;
}

// Bridge between the store's named arrays and the op-stack's AnnotState shape.
function toOpState(s: AnnotationUIState): AnnotState {
  return { annots: s.annots, undo: s.undoStack, redo: s.redoStack };
}
function fromOpState(n: AnnotState) {
  return { annots: n.annots, undoStack: n.undo, redoStack: n.redo };
}

// Persist the net effect of an op to the server (fire-and-forget; the op-stack
// is the in-memory source of truth and the UI updates optimistically).
function persistOp(arxivId: string, op: Op): void {
  switch (op.kind) {
    case "add":
      void api.putAnnotation({ ...op.annot, arxiv_id: arxivId });
      break;
    case "remove":
      void api.deleteAnnotation(op.annot.id);
      break;
    case "edit":
    case "move":
    case "resize":
      void api.putAnnotation({ ...op.after, arxiv_id: arxivId });
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
  drawSession: {},

  load: async (arxivId) => {
    const raw = await api.listAnnotations(arxivId);
    // Run the legacy draw.points→draw.strokes migration on read (defensive —
    // the migrate/import endpoint already bakes it in, but a row written by an
    // older client would still need this).
    const annots = raw.map(migrateAnnotation);
    set({ arxivId, annots, undoStack: [], redoStack: [], selectedId: null, drawSession: {} });
  },

  addAnnot: (partial) => {
    const { arxivId } = get();
    if (!arxivId) return;
    const annot: Annotation = {
      ...partial,
      id: newId(),
      arxiv_id: arxivId,
      createdAt: Date.now(),
    };
    const op: Op = { kind: "add", annot };
    persistOp(arxivId, op);
    set((s) => fromOpState(commit(toOpState(s), op)));
  },

  // Sticky freehand: group a whole drawing session into ONE annotation.
  // First stroke on a page creates the block (add op) and records its id in
  // drawSession[page]; subsequent strokes on the same page append via editAnnot
  // (before = current block, after = block + new stroke). Strokes commit
  // immediately, so a page unmounting mid-session never loses data. drawSession
  // is cleared on setTool(!= "draw"), ending the session.
  addDrawStroke: (page, stroke, color, width) => {
    const { arxivId, drawSession, annots } = get();
    if (!arxivId || stroke.length < 2) return;
    const existingId = drawSession[page];
    const existing = existingId ? annots.find((a) => a.id === existingId && a.type === "draw") : undefined;
    if (existing && existing.draw) {
      const after: Annotation = {
        ...existing,
        draw: { ...existing.draw, strokes: [...existing.draw.strokes, stroke] },
      };
      get().editAnnot(existing, after);
      return;
    }
    // New session block on this page.
    const annot: Annotation = {
      id: newId(), arxiv_id: arxivId, page, type: "draw", color,
      createdAt: Date.now(), draw: { strokes: [stroke], width },
    };
    const op: Op = { kind: "add", annot };
    persistOp(arxivId, op);
    set((s) => {
      const next = fromOpState(commit(toOpState(s), op));
      return { ...next, drawSession: { ...s.drawSession, [page]: annot.id } };
    });
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
        void api.deleteAnnotation(op.annot.id);
        break;
      case "remove": // inverse = add
        void api.putAnnotation({ ...op.annot, arxiv_id: arxivId });
        break;
      case "edit":
      case "move":
      case "resize": // inverse = restore before
        void api.putAnnotation({ ...op.before, arxiv_id: arxivId });
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

  setTool: (t) =>
    set((s) => ({
      tool: t,
      selectedId: t === "none" ? s.selectedId : null,
      // Leaving the draw tool ends the freehand session: drop the open-block
      // pointer. The block itself stays (already committed); only the
      // "append next stroke here" state resets.
      drawSession: t === "draw" ? s.drawSession : {},
    })),
  setColor: (c) => set({ color: c }),
  toggleHighlight: () => set((s) => ({ highlightOn: !s.highlightOn })),
  select: (id) => set({ selectedId: id }),
}));

// Selectors
export const usePageAnnotations = (page: number) =>
  useAnnotations((s) => s.annots.filter((a) => a.page === page));

export const useCanUndo = () => useAnnotations((s) => s.undoStack.length > 0);
export const useCanRedo = () => useAnnotations((s) => s.redoStack.length > 0);
