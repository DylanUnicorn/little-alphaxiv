import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  composerProps: null as any,
  runConversation: vi.fn(async (_options: any) => ({ newMessages: [] })),
  replaceFromUserMessage: vi.fn(async (_id: string, _index: number, message: any) => ({
    id: "general-edit",
    type: "general" as const,
    title: "Question",
    provider_id: "provider",
    messages: [message],
    created_at: 1,
    updated_at: 2,
  })),
}));

const conversationState = vi.hoisted(() => ({
  conversations: [{
    id: "general-edit",
    history_id: "general-edit",
    type: "general" as const,
    title: "Question",
    provider_id: "provider",
    messages: [
      { role: "user" as const, content: "typo $x$" },
      { role: "assistant" as const, content: "obsolete" },
    ],
    created_at: 1,
    updated_at: 1,
  }],
  appendMessages: vi.fn(async () => undefined),
  branchFromMessage: vi.fn(),
  replaceFromUserMessage: runtime.replaceFromUserMessage,
  rename: vi.fn(async () => undefined),
  updateSettings: vi.fn(async () => undefined),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../store/conversations", () => ({
  useConversations: (selector: (state: typeof conversationState) => unknown) => selector(conversationState),
}));
vi.mock("../store/chatRuntime", () => {
  const state = {
    turns: {},
    startTurn: vi.fn(() => true),
    updateTurn: vi.fn(),
    appendReasoning: vi.fn(),
    setNotice: vi.fn(),
    stopTurn: vi.fn(),
    finishTurn: vi.fn(),
    acknowledgeCompletion: vi.fn(),
  };
  return {
    EMPTY_CHAT_TURN: { busy: false, status: "", streaming: "", reasoning: "" },
    useChatRuntime: (selector: (value: typeof state) => unknown) => selector(state),
  };
});
vi.mock("../store/settings", () => ({
  useSettings: (selector: (state: any) => unknown) => selector({
    getProvider: () => ({ id: "provider", model: "model", name: "Provider" }),
    searchSources: {
      openalex: { enabled: false },
      semanticScholar: { enabled: false },
      anysearch: { enabled: false },
    },
    aiOutputFormat: { fontSize: 15, lineHeight: 1.6, paragraphSpacing: 8, mathScale: 1 },
    getCachedModels: () => [{ id: "model" }],
    fetchAndCacheModels: vi.fn(),
  }),
}));
vi.mock("../lib/llm", () => ({
  runConversation: runtime.runConversation,
  generateConversationTitle: vi.fn(async () => ""),
}));
vi.mock("./ChatComposer", () => ({
  ChatComposer: (props: any) => {
    runtime.composerProps = props;
    return React.createElement("button", { "aria-label": "Send edited", onClick: props.onSend }, "Send");
  },
}));
vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));
vi.mock("./Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactElement }) => children,
}));

import { ChatPanel } from "./ChatPanel";

describe("ChatPanel message editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.composerProps = null;
  });

  it("hydrates the composer and resends from the edited user message", async () => {
    let tree!: ReturnType<typeof create>;
    act(() => { tree = create(<ChatPanel conversationId="general-edit" />); });

    act(() => tree.root.findByProps({ "aria-label": "Edit message" }).props.onClick());

    expect(runtime.composerProps.value).toBe("typo $x$");
    expect(runtime.composerProps.selectedTextContext.label).toBe("Editing message");
    expect(runtime.composerProps.selectedTextContextCanSubmitWithoutText).toBe(false);
    expect(runtime.composerProps.focusRequest).toBeGreaterThan(0);

    act(() => runtime.composerProps.onValueChange(""));
    await act(async () => runtime.composerProps.onSend());
    expect(runtime.replaceFromUserMessage).not.toHaveBeenCalled();

    act(() => runtime.composerProps.onValueChange("corrected $x^2$"));
    await act(async () => runtime.composerProps.onSend());

    expect(runtime.replaceFromUserMessage).toHaveBeenCalledWith(
      "general-edit",
      0,
      { role: "user", content: "corrected $x^2$" },
    );
    expect(runtime.runConversation).toHaveBeenCalledTimes(1);
    expect(runtime.runConversation.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "corrected $x^2$" },
    ]);
  });
});
