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
