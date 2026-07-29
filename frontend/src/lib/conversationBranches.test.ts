import { describe, expect, it } from "vitest";
import type { ChatMessage, Conversation } from "../types";
import {
  branchMessagesThrough,
  collectConversationSubtreeIds,
  groupConversationHistories,
  isPendingBranchConversation,
  layoutConversationTree,
  normalizeBranchExcerpt,
} from "./conversationBranches";

const messages: ChatMessage[] = [
  { role: "user", content: "Start" },
  { role: "assistant", content: "First answer mentions representation collapse." },
  { role: "user", content: "Continue" },
  { role: "assistant", content: "Later answer" },
];

function conv(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    type: "general",
    messages,
    created_at: 100,
    updated_at: 100,
    ...patch,
  };
}

describe("conversation branch semantics", () => {
  it("copies context only through the selected assistant message", () => {
    expect(branchMessagesThrough(conv("root"), 1)).toEqual(messages.slice(0, 2));
    expect(() => branchMessagesThrough(conv("root"), 0)).toThrow(/assistant/i);
    expect(() => branchMessagesThrough(conv("root"), 9)).toThrow(/assistant/i);
  });

  it("normalizes whitespace and caps persisted excerpts", () => {
    expect(normalizeBranchExcerpt("  representation\n  collapse  ")).toBe("representation collapse");
    const capped = normalizeBranchExcerpt("x".repeat(2_100));
    expect(capped).toHaveLength(2_000);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("recognizes a fresh child as waiting for its first branch question", () => {
    const child = conv("child", {
      history_id: "root",
      parent_id: "root",
      branch_from_message_index: 1,
      branch_excerpt: "representation collapse",
      messages: messages.slice(0, 2),
    });
    expect(isPendingBranchConversation(child)).toBe(true);
    expect(isPendingBranchConversation({
      ...child,
      messages: [...child.messages, { role: "user", content: "Explain it" }],
    })).toBe(false);
  });
});

describe("History grouping and tree layout", () => {
  const root = conv("root", { history_id: "root", updated_at: 200 });
  const left = conv("left", {
    history_id: "root",
    parent_id: "root",
    branch_from_message_index: 1,
    branch_excerpt: "left",
    updated_at: 300,
  });
  const right = conv("right", {
    history_id: "root",
    parent_id: "root",
    branch_from_message_index: 1,
    branch_excerpt: "right",
    updated_at: 250,
  });
  const leaf = conv("leaf", {
    history_id: "root",
    parent_id: "left",
    branch_from_message_index: 3,
    branch_excerpt: "leaf",
    updated_at: 400,
  });

  it("groups descendants under one root and chooses the most recently touched node", () => {
    const legacy = conv("legacy", { history_id: undefined, updated_at: 150 });
    const orphan = conv("orphan", { history_id: "missing-root", parent_id: "missing-root" });
    const groups = groupConversationHistories([right, legacy, leaf, root, orphan, left]);

    expect(groups.map((group) => group.id)).toEqual(["root", "legacy", "orphan"]);
    expect(groups[0].root.id).toBe("root");
    expect(groups[0].representative.id).toBe("leaf");
    expect(groups[0].nodes.map((node) => node.id).sort()).toEqual(["leaf", "left", "right", "root"]);
    expect(groups[1].root.id).toBe("legacy");
    expect(groups[2].root.id).toBe("orphan");
  });

  it("collects a node and every descendant without deleting siblings", () => {
    const ids = collectConversationSubtreeIds([root, left, right, leaf], "left");
    expect(ids.sort()).toEqual(["leaf", "left"]);
  });

  it("lays out parent nodes above children and separates sibling branches", () => {
    const layout = layoutConversationTree([leaf, right, root, left]);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("root")?.depth).toBe(0);
    expect(byId.get("left")?.depth).toBe(1);
    expect(byId.get("right")?.depth).toBe(1);
    expect(byId.get("leaf")?.depth).toBe(2);
    expect(byId.get("left")?.x).not.toBe(byId.get("right")?.x);
    expect(byId.get("root")!.y).toBeLessThan(byId.get("left")!.y);
    expect(layout.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentId: "root", childId: "left" }),
      expect.objectContaining({ parentId: "root", childId: "right" }),
      expect.objectContaining({ parentId: "left", childId: "leaf" }),
    ]));
  });
});
