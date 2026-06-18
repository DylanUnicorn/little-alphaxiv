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
