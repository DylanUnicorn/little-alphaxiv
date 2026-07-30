import { describe, expect, it } from "vitest";
import type { Conversation } from "../types";
import { newlyAddedBranchIds } from "./historyBranchReveal";

function conversation(id: string, parentId?: string, historyId = "root"): Conversation {
  return {
    id,
    history_id: historyId,
    parent_id: parentId,
    title: id,
    type: "paper",
    paper_id: "paper:test",
    messages: [],
    created_at: 100,
    updated_at: 100,
  };
}

describe("newlyAddedBranchIds", () => {
  it("does not treat initial hydration as branch creation", () => {
    expect(newlyAddedBranchIds(null, [
      conversation("root"),
      conversation("existing-child", "root"),
    ])).toEqual([]);
  });

  it("returns only newly inserted child conversations", () => {
    const known = new Set(["root", "existing-child"]);
    expect(newlyAddedBranchIds(known, [
      conversation("root"),
      conversation("existing-child", "root"),
      conversation("new-child", "root"),
    ])).toEqual(["new-child"]);
  });

  it("ignores a newly inserted root conversation", () => {
    expect(newlyAddedBranchIds(new Set(["root"]), [
      conversation("root"),
      conversation("new-root", undefined, "new-root"),
    ])).toEqual([]);
  });

  it("keeps detection scoped to the supplied History nodes", () => {
    const known = new Set(["root"]);
    expect(newlyAddedBranchIds(known, [
      conversation("root"),
      conversation("active-child", "root"),
    ])).toEqual(["active-child"]);
  });
});
