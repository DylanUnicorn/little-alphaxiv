import { describe, it, expect } from "vitest";
import { commit, undoOp, redoOp, type AnnotState } from "./opstack";
import type { Annotation } from "../types";

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
