import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Provider } from "../types";

const api = vi.hoisted(() => ({
  streamChat: vi.fn(),
  completeChat: vi.fn(),
  searchArxiv: vi.fn(),
  searchOpenAlex: vi.fn(),
  searchSemanticScholar: vi.fn(),
  webSearch: vi.fn(),
}));

vi.mock("./api", () => api);

import { runConversation } from "./llm";

const provider: Provider = {
  id: "provider-1",
  name: "Test",
  base_url: "https://example.invalid/v1",
  api_key: "test",
  model: "test-model",
  api_format: "chat_completions",
};

describe("runConversation tool recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pairs a failed arXiv call with a tool result and lets the model continue", async () => {
    api.streamChat
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-arxiv-1",
          type: "function",
          function: { name: "search_arxiv", arguments: '{"query":"CLIP"}' },
        }],
        finish_reason: "tool_calls",
      })
      .mockResolvedValueOnce({
        content: "I will retry with a revised query or another source.",
        tool_calls: [],
        finish_reason: "stop",
      });
    api.searchArxiv.mockRejectedValue(new Error("arxiv search error 429"));
    const onToolMessage = vi.fn();

    const result = await runConversation({
      provider,
      messages: [{ role: "user", content: "Find CLIP papers" }],
      callbacks: { onToolMessage },
    });

    expect(api.streamChat).toHaveBeenCalledTimes(2);
    expect(api.streamChat.mock.calls[1][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-arxiv-1",
        name: "search_arxiv",
        content: expect.stringContaining("arxiv search failed"),
      }),
    ]));
    expect(result.newMessages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.newMessages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "call-arxiv-1",
      name: "search_arxiv",
    });
    expect(onToolMessage).toHaveBeenCalledWith(result.newMessages[1]);
  });

  it("repairs a legacy assistant call that has no tool output before a follow-up", async () => {
    let requestMessages: any[] = [];
    api.streamChat.mockImplementationOnce(async (options: any) => {
      requestMessages = structuredClone(options.messages);
      return {
        content: "Continuing after the interrupted search.",
        tool_calls: [],
        finish_reason: "stop",
      };
    });

    await runConversation({
      provider,
      messages: [
        { role: "user", content: "Find CLIP papers" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-old-arxiv",
            type: "function",
            function: { name: "search_arxiv", arguments: '{"query":"CLIP"}' },
          }],
        },
        { role: "user", content: "Continue" },
      ],
      callbacks: {},
    });

    expect(requestMessages.map((message: any) => ({
      role: message.role,
      tool_call_id: message.tool_call_id,
    }))).toEqual([
      { role: "user", tool_call_id: undefined },
      { role: "assistant", tool_call_id: undefined },
      { role: "tool", tool_call_id: "call-old-arxiv" },
      { role: "user", tool_call_id: undefined },
    ]);
    expect(requestMessages[2]).toMatchObject({
      name: "search_arxiv",
      content: expect.stringContaining("did not complete"),
    });
  });
});
