import React from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "../types";
import { ConversationTree } from "./ConversationTree";

function node(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    history_id: "root",
    title: id,
    type: "paper",
    paper_id: "2401.00001",
    messages: [{ role: "user", content: id }],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("ConversationTree generation state", () => {
  it("marks only the owning node as generating and exposes an accessible label", () => {
    const nodes = [
      node("root", { history_id: "root" }),
      node("branch-a", { parent_id: "root" }),
      node("branch-b", { parent_id: "root" }),
    ];
    const tree = create(React.createElement(ConversationTree, {
      nodes,
      activeId: "branch-b",
      generatingIds: new Set(["branch-a"]),
      onSelect: vi.fn(),
    }));

    const branchA = tree.root.find(
      (element) => element.type === "button" && element.props["data-node-id"] === "branch-a",
    );
    const branchB = tree.root.find(
      (element) => element.type === "button" && element.props["data-node-id"] === "branch-b",
    );

    expect(branchA.props.className).toContain("generating");
    expect(branchA.props["data-generating"]).toBe("true");
    expect(branchA.props["aria-label"]).toContain("generating response");
    expect(branchA.findByProps({ className: "conversation-tree-node-spinner" })).toBeTruthy();

    expect(branchB.props.className).not.toContain("generating");
    expect(branchB.props["data-generating"]).toBe("false");
    expect(branchB.props["aria-label"]).not.toContain("generating response");
    expect(branchB.findAllByProps({ className: "conversation-tree-node-spinner" })).toHaveLength(0);
  });
});
