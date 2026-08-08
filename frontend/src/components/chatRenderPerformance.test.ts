import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ markdown: 0, navigate: vi.fn() }));

const conversationState = vi.hoisted(() => {
  const conversation = {
    id: "paper-thread",
    type: "paper" as const,
    paper_id: "2401.00001",
    title: "Test paper",
    messages: [
      { role: "user" as const, content: "Compare $q$ and $k$" },
      { role: "assistant" as const, content: "Rendered **answer**" },
    ],
    created_at: 1,
    updated_at: 1,
  };
  return {
    conversations: [conversation],
    appendMessages: vi.fn(async () => undefined),
    branchFromMessage: vi.fn(async () => conversation),
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
  Markdown: ({ children }: { children: React.ReactNode }) => {
    runtime.markdown += 1;
    return React.createElement("div", null, children);
  },
}));

vi.mock("./ChatComposer", () => ({
  ChatComposer: ({ onValueChange }: { onValueChange: (value: string) => void }) => (
    React.createElement(
      "button",
      { type: "button", onClick: () => onValueChange("draft $x_i^2$ changed") },
      "Edit draft",
    )
  ),
}));

import { ChatPanel } from "./ChatPanel";

describe("ChatPanel draft rendering", () => {
  beforeEach(() => {
    runtime.markdown = 0;
  });

  it("does not re-render historical Markdown when the composer draft gains math", () => {
    const tree = create(React.createElement(ChatPanel, { conversationId: "paper-thread" }));
    expect(runtime.markdown).toBe(2);

    act(() => {
      tree.root.findByType("button").props.onClick();
    });

    expect(runtime.markdown).toBe(2);
  });
});
