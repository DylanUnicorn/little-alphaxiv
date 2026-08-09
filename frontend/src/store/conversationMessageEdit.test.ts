import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Conversation } from "../types";

vi.mock("../lib/api", () => ({
  listConversations: vi.fn(async () => []),
  getConversation: vi.fn(),
  putConversation: vi.fn(async (conversation: Conversation) => conversation),
  deleteConversation: vi.fn(),
}));

import * as api from "../lib/api";
import { useConversations } from "./conversations";

const original = (): Conversation => ({
  id: "general-edit",
  history_id: "general-edit",
  title: "Wrong question",
  type: "general",
  provider_id: "provider",
  messages: [
    { role: "user", content: "first" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "typo", attachments: [{ type: "image", data_url: "data:image/png;base64,old" }] },
    { role: "assistant", content: "obsolete answer" },
    { role: "tool", content: "obsolete tool output", tool_call_id: "call-1" },
  ],
  created_at: 1,
  updated_at: 2,
});

describe("conversation message replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.putConversation).mockImplementation(async (conversation) => conversation);
    useConversations.setState({
      conversations: [original()],
      activeId: "general-edit",
      hasHistory: true,
    });
  });

  it("persists the preserved prefix and edited user message, removing every later message", async () => {
    const replacement: ChatMessage = {
      role: "user",
      content: "corrected question",
      attachments: [{ type: "image", data_url: "data:image/png;base64,new" }],
    };

    const updated = await useConversations.getState().replaceFromUserMessage(
      "general-edit",
      2,
      replacement,
    );

    expect(api.putConversation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.putConversation).mock.calls[0][0].messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
      replacement,
    ]);
    expect(updated.messages).toEqual(vi.mocked(api.putConversation).mock.calls[0][0].messages);
    expect(useConversations.getState().conversations[0].messages).toEqual(updated.messages);
    expect(updated.updated_at).toBeGreaterThan(2);
  });

  it("rejects a missing or non-user target without writing", async () => {
    const replacement: ChatMessage = { role: "user", content: "corrected" };

    await expect(
      useConversations.getState().replaceFromUserMessage("general-edit", 1, replacement),
    ).rejects.toThrow(/user message/i);
    await expect(
      useConversations.getState().replaceFromUserMessage("missing", 0, replacement),
    ).rejects.toThrow(/not found/i);

    expect(api.putConversation).not.toHaveBeenCalled();
    expect(useConversations.getState().conversations[0]).toEqual(original());
  });

  it("keeps local history intact when persistence fails", async () => {
    vi.mocked(api.putConversation).mockRejectedValueOnce(new Error("offline"));

    await expect(
      useConversations.getState().replaceFromUserMessage(
        "general-edit",
        2,
        { role: "user", content: "corrected" },
      ),
    ).rejects.toThrow("offline");

    expect(useConversations.getState().conversations[0]).toEqual(original());
  });
});
