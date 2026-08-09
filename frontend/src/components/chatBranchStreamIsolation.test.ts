import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ navigate: vi.fn() }));

const conversationState = vi.hoisted(() => {
  const base = {
    type: "paper" as const,
    paper_id: "2401.00001",
    messages: [],
    created_at: 1,
    updated_at: 1,
  };
  return {
    conversations: [
      { ...base, id: "branch-a", title: "Branch A" },
      { ...base, id: "branch-b", title: "Branch B" },
    ],
    appendMessages: vi.fn(async () => undefined),
    branchFromMessage: vi.fn(async () => ({ ...base, id: "branch-c", title: "Branch C" })),
    rename: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => undefined),
  };
});

const settingsState = vi.hoisted(() => ({
  provider: { id: "provider", model: "model", name: "Provider" },
  searchSources: {
    openalex: { enabled: false },
    semanticScholar: { enabled: false },
    anysearch: { enabled: false },
  },
  aiOutputFormat: {
    fontSize: 15,
    lineHeight: 1.6,
    paragraphSpacing: 8,
    mathScale: 1,
  },
  models: [{ id: "model" }],
  fetchAndCacheModels: vi.fn(async () => undefined),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => runtime.navigate,
}));

vi.mock("../store/conversations", () => ({
  useConversations: (selector: (state: typeof conversationState) => unknown) =>
    selector(conversationState),
}));

vi.mock("../store/settings", () => ({
  useSettings: (selector: (state: any) => unknown) =>
    selector({
      getProvider: () => settingsState.provider,
      searchSources: settingsState.searchSources,
      aiOutputFormat: settingsState.aiOutputFormat,
      getCachedModels: () => settingsState.models,
      fetchAndCacheModels: settingsState.fetchAndCacheModels,
    }),
}));

vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => (
    React.createElement("div", { "data-markdown": true }, children)
  ),
}));

vi.mock("./ChatComposer", () => ({
  ChatComposer: () => React.createElement("div", { "data-composer": true }),
}));

import { EMPTY_CHAT_TURN, useChatRuntime } from "../store/chatRuntime";
import { ChatPanel } from "./ChatPanel";

function renderedMarkdown(tree: ReturnType<typeof create>): string[] {
  return tree.root
    .findAll((node) => node.props["data-markdown"] === true)
    .map((node) => node.children.join(""));
}

describe("ChatPanel branch stream isolation", () => {
  beforeEach(() => {
    useChatRuntime.getState().resetForTests();
  });

  it("shows partial output only for the conversation that owns the turn", () => {
    const controller = new AbortController();
    useChatRuntime.getState().startTurn("branch-a", controller);
    useChatRuntime.getState().updateTurn("branch-a", controller, {
      streaming: "A is still answering",
    });

    const tree = create(React.createElement(ChatPanel, { conversationId: "branch-a" }));
    expect(renderedMarkdown(tree)).toContain("A is still answering");

    act(() => {
      tree.update(React.createElement(ChatPanel, { conversationId: "branch-b" }));
    });
    expect(renderedMarkdown(tree)).not.toContain("A is still answering");
    expect(useChatRuntime.getState().turns["branch-a"]?.busy).toBe(true);
    expect(useChatRuntime.getState().turns["branch-b"] ?? EMPTY_CHAT_TURN).toBe(EMPTY_CHAT_TURN);

    act(() => {
      tree.update(React.createElement(ChatPanel, { conversationId: "branch-a" }));
    });
    expect(renderedMarkdown(tree)).toContain("A is still answering");
  });

  it("acknowledges a completed response when its branch becomes active", () => {
    const controller = new AbortController();
    useChatRuntime.getState().startTurn("branch-b", controller);
    useChatRuntime.getState().finishTurn("branch-b", controller, true);
    expect(useChatRuntime.getState().completedIds.has("branch-b")).toBe(true);

    act(() => {
      create(React.createElement(ChatPanel, { conversationId: "branch-b" }));
    });

    expect(useChatRuntime.getState().completedIds.has("branch-b")).toBe(false);
  });
});
