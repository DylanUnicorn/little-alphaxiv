import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../types";

vi.mock("../lib/api", () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(),
  putConversation: vi.fn(async (conversation: Conversation) => conversation),
  deleteConversation: vi.fn(async (id: string) => ({ ok: true, deleted_ids: [id] })),
}));

import * as api from "../lib/api";
import { useConversations } from "./conversations";

function rootConversation(): Conversation {
  return {
    id: "root",
    history_id: "root",
    title: "Root",
    type: "general",
    provider_id: "provider-a",
    model: "model-a",
    style_preset: "thorough",
    context_capacity_override: 64_000,
    reserve_tokens: 8_000,
    messages: [
      { role: "user", content: "Start" },
      { role: "assistant", content: "Representation collapse is a failure mode." },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Later answer" },
    ],
    created_at: 100,
    updated_at: 100,
  };
}

describe("conversation branching store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.putConversation).mockImplementation(async (conversation) => conversation);
    vi.mocked(api.deleteConversation).mockImplementation(async (id) => ({ ok: true, deleted_ids: [id] }));
    useConversations.setState({
      conversations: [rootConversation()],
      activeId: "root",
      hasHistory: true,
    });
  });

  it("persists a child with the selected message prefix before activating it", async () => {
    const child = await useConversations.getState().branchFromMessage({
      conversationId: "root",
      messageIndex: 1,
      excerpt: "  Representation\n collapse  ",
    });

    expect(api.putConversation).toHaveBeenCalledTimes(1);
    expect(child.history_id).toBe("root");
    expect(child.parent_id).toBe("root");
    expect(child.branch_from_message_index).toBe(1);
    expect(child.branch_excerpt).toBe("Representation collapse");
    expect(child.messages).toEqual(rootConversation().messages.slice(0, 2));
    expect(child.provider_id).toBe("provider-a");
    expect(child.model).toBe("model-a");
    expect(child.style_preset).toBe("thorough");
    expect(child.context_capacity_override).toBe(64_000);
    expect(child.reserve_tokens).toBe(8_000);
    expect(useConversations.getState().activeId).toBe(child.id);
  });

  it("does not create local state when persistence fails", async () => {
    vi.mocked(api.putConversation).mockRejectedValueOnce(new Error("offline"));

    await expect(useConversations.getState().branchFromMessage({
      conversationId: "root",
      messageIndex: 1,
      excerpt: "collapse",
    })).rejects.toThrow("offline");

    expect(useConversations.getState().conversations.map((conversation) => conversation.id)).toEqual(["root"]);
    expect(useConversations.getState().activeId).toBe("root");
  });

  it("assigns self lineage to every newly created root", async () => {
    useConversations.setState({ conversations: [], activeId: null });
    const root = await useConversations.getState().create({ type: "general" });
    expect(root.history_id).toBe(root.id);
    expect(root.parent_id).toBeUndefined();
  });

  it("removes every server-reported descendant from local state", async () => {
    const root = rootConversation();
    const child: Conversation = {
      ...root,
      id: "child",
      history_id: "root",
      parent_id: "root",
      branch_from_message_index: 1,
      branch_excerpt: "collapse",
      messages: root.messages.slice(0, 2),
    };
    const leaf: Conversation = {
      ...child,
      id: "leaf",
      parent_id: "child",
    };
    useConversations.setState({ conversations: [root, child, leaf], activeId: "leaf" });
    vi.mocked(api.deleteConversation).mockResolvedValueOnce({
      ok: true,
      deleted_ids: ["child", "leaf"],
    });

    await useConversations.getState().remove("child");

    expect(useConversations.getState().conversations.map((conversation) => conversation.id)).toEqual(["root"]);
    expect(useConversations.getState().activeId).toBeNull();
  });
});
