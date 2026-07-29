import { describe, expect, it } from "vitest";
import type { ChatMessage, Paper, ToolCall } from "../types";
import { buildChatRenderItems } from "./agentActivity";

function call(id: string, name: string, args: Record<string, unknown> | string): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

function paper(title: string): Paper {
  return {
    arxiv_id: "",
    title,
    authors: [],
    abstract: "",
    pdf_url: "",
    abs_url: "",
    published: "",
    primary_category: "",
  };
}

describe("buildChatRenderItems", () => {
  it("groups a tool call and result into one readable activity item", () => {
    const papers = ["Alpha", "Beta", "Gamma", "Delta"].map(paper);
    const messages: ChatMessage[] = [
      { role: "user", content: "Find related work" },
      {
        role: "assistant",
        content: null,
        tool_calls: [call("tc-1", "search_arxiv", { query: "latent robot actions", max_results: 8 })],
      },
      {
        role: "tool",
        content: JSON.stringify(papers),
        name: "search_arxiv",
        tool_call_id: "tc-1",
        ui: { papers },
      },
      { role: "assistant", content: "Here is what I found." },
    ];

    const items = buildChatRenderItems(messages);

    expect(items.map((item) => item.kind)).toEqual(["message", "activity", "message"]);
    const activity = items[1];
    expect(activity.kind).toBe("activity");
    if (activity.kind !== "activity") return;
    expect(activity.steps).toEqual([
      expect.objectContaining({
        id: "tc-1",
        toolName: "search_arxiv",
        label: "arXiv search",
        query: "latent robot actions",
        status: "success",
        resultCount: 4,
        resultTitles: ["Alpha", "Beta", "Gamma"],
      }),
    ]);
    expect(activity.totalResults).toBe(4);
  });

  it("keeps several tool rounds in one activity group before the final answer", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Compare the implementations" },
      { role: "assistant", content: null, tool_calls: [call("web-1", "web_search", { query: "Motus GitHub" })] },
      { role: "tool", content: '[{"title":"Motus repository"}]', name: "web_search", tool_call_id: "web-1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          call("oa-1", "search_openalex", { query: "unified world model" }),
          call("s2-1", "search_semantic_scholar", { query: "latent action model" }),
        ],
      },
      { role: "tool", content: "[]", name: "search_openalex", tool_call_id: "oa-1" },
      { role: "tool", content: '[{"title":"Latent Action Models"},{"title":"Robot World Models"}]', name: "search_semantic_scholar", tool_call_id: "s2-1" },
      { role: "assistant", content: "The main distinction is..." },
    ];

    const items = buildChatRenderItems(messages);

    expect(items).toHaveLength(3);
    const activity = items[1];
    expect(activity.kind).toBe("activity");
    if (activity.kind !== "activity") return;
    expect(activity.steps.map((step) => step.toolName)).toEqual([
      "web_search",
      "search_openalex",
      "search_semantic_scholar",
    ]);
    expect(activity.totalResults).toBe(3);
  });

  it("marks a failed result without exposing a raw payload", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("web-1", "web_search", { query: "paper source" })] },
      { role: "tool", content: "web search failed (rate limited); try search_arxiv", name: "web_search", tool_call_id: "web-1" },
    ];

    const [activity] = buildChatRenderItems(messages);

    expect(activity.kind).toBe("activity");
    if (activity.kind !== "activity") return;
    expect(activity.steps[0]).toEqual(expect.objectContaining({
      status: "error",
      errorMessage: "Search failed: rate limited",
      resultTitles: [],
    }));
  });

  it("tolerates malformed arguments and result content", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("odd-1", "custom_lookup", "{not json")] },
      { role: "tool", content: "not json either", name: "custom_lookup", tool_call_id: "odd-1" },
    ];

    const [activity] = buildChatRenderItems(messages);

    expect(activity.kind).toBe("activity");
    if (activity.kind !== "activity") return;
    expect(activity.steps[0]).toEqual(expect.objectContaining({
      label: "Custom lookup",
      query: undefined,
      status: "success",
      resultCount: undefined,
      resultTitles: [],
    }));
  });

  it("shows an unmatched call as pending and omits truly empty assistant rows", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null },
      { role: "assistant", content: null, tool_calls: [call("pending-1", "web_search", { query: "in progress" })] },
    ];

    const items = buildChatRenderItems(messages);

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("activity");
    if (items[0].kind !== "activity") return;
    expect(items[0].steps[0].status).toBe("pending");
  });
});
