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
  conversations: [] as any[],
  appendMessages: vi.fn(async () => undefined),
  branchFromMessage: vi.fn(),
  replaceFromUserMessage: runtime.replaceFromUserMessage,
  rename: vi.fn(async () => undefined),
  updateSettings: vi.fn(async () => undefined),
}));

const runtimeState = vi.hoisted(() => ({
  turns: {} as Record<string, unknown>,
  startTurn: vi.fn(() => true),
  updateTurn: vi.fn(),
  appendReasoning: vi.fn(),
  setNotice: vi.fn(),
  stopTurn: vi.fn(),
  finishTurn: vi.fn(),
  acknowledgeCompletion: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../store/conversations", () => ({
  useConversations: (selector: (state: typeof conversationState) => unknown) => selector(conversationState),
}));
vi.mock("../store/chatRuntime", () => ({
  EMPTY_CHAT_TURN: { busy: false, status: "", streaming: "", reasoning: "" },
  useChatRuntime: (selector: (value: typeof runtimeState) => unknown) => selector(runtimeState),
}));
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
    return React.createElement("div", { "aria-label": "Main composer", "data-disabled": props.disabled });
  },
}));
vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}));
vi.mock("./Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactElement }) => children,
}));

import { ChatPanel } from "./ChatPanel";

function renderPanel(conversationId = "general-edit") {
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(<ChatPanel conversationId={conversationId} />); });
  return tree;
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "general-edit",
    history_id: "general-edit",
    type: "general" as const,
    title: "Question",
    provider_id: "provider",
    messages: [
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
      {
        role: "user" as const,
        content: "typo $x$",
        attachments: [{ type: "image" as const, data_url: "data:image/png;base64,abc", name: "plot.png" }],
      },
      { role: "assistant" as const, content: "obsolete" },
    ],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("ChatPanel inline message editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.composerProps = null;
    conversationState.conversations = [conversation()];
  });

  it("offers Edit only on the latest user prompt while Copy remains on older prompts", () => {
    const tree = renderPanel();

    expect(tree.root.findAllByProps({ "aria-label": "Copy message" })).toHaveLength(2);
    expect(tree.root.findAllByProps({ "aria-label": "Edit message" })).toHaveLength(1);
  });

  it("turns the original bubble into an editor and leaves the main composer draft alone", () => {
    const tree = renderPanel();

    act(() => tree.root.findByProps({ "aria-label": "Edit message" }).props.onClick());

    const textarea = tree.root.findByType("textarea");
    expect(textarea.props.value).toBe("typo $x$");
    expect(tree.root.findByProps({ alt: "plot.png" })).toBeTruthy();
    expect(runtime.composerProps.value).toBe("");
    expect(runtime.composerProps.disabled).toBe(true);
    expect(runtime.composerProps.placeholder).toBe("Finish editing the message above…");
  });

  it("cancels without changing history", () => {
    const tree = renderPanel();
    act(() => tree.root.findByProps({ "aria-label": "Edit message" }).props.onClick());

    act(() => tree.root.findByProps({ children: "Cancel" }).props.onClick());

    expect(tree.root.findAllByType("textarea")).toHaveLength(0);
    expect(runtime.replaceFromUserMessage).not.toHaveBeenCalled();
    expect(runtime.composerProps.disabled).toBe(false);
  });

  it("resends the edited prompt from the correct index and truncates the LLM context", async () => {
    const tree = renderPanel();
    act(() => tree.root.findByProps({ "aria-label": "Edit message" }).props.onClick());
    const textarea = tree.root.findByType("textarea");

    act(() => textarea.props.onChange({ target: { value: "corrected $x^2$" } }));
    await act(async () => tree.root.findByProps({ children: "Resend" }).props.onClick());

    expect(runtime.replaceFromUserMessage).toHaveBeenCalledWith(
      "general-edit",
      2,
      {
        role: "user",
        content: "corrected $x^2$",
        attachments: [{ type: "image", data_url: "data:image/png;base64,abc", name: "plot.png" }],
      },
    );
    expect(runtime.runConversation.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      {
        role: "user",
        content: "corrected $x^2$",
        attachments: [{ type: "image", data_url: "data:image/png;base64,abc", name: "plot.png" }],
      },
    ]);
  });

  it("keeps the inline draft open when persistence fails", async () => {
    runtime.replaceFromUserMessage.mockRejectedValueOnce(new Error("offline"));
    const tree = renderPanel();
    act(() => tree.root.findByProps({ "aria-label": "Edit message" }).props.onClick());
    act(() => tree.root.findByType("textarea").props.onChange({ target: { value: "unsaved draft" } }));

    await act(async () => tree.root.findByProps({ children: "Resend" }).props.onClick());

    expect(tree.root.findByType("textarea").props.value).toBe("unsaved draft");
    expect(runtime.runConversation).not.toHaveBeenCalled();
  });

  it("does not allow editing a user prompt inherited from a parent paper branch", () => {
    conversationState.conversations = [conversation({
      id: "paper-child",
      history_id: "paper-root",
      type: "paper",
      paper_id: "1234.5678",
      branch_from_message_index: 0,
      messages: [
        { role: "user", content: "inherited question" },
        { role: "assistant", content: "branched reply" },
      ],
    })];

    const tree = renderPanel("paper-child");

    expect(tree.root.findAllByProps({ "aria-label": "Copy message" })).toHaveLength(1);
    expect(tree.root.findAllByProps({ "aria-label": "Edit message" })).toHaveLength(0);
  });
});
