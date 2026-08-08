// @vitest-environment jsdom
import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../store/settings", () => ({
  useSettings: (selector: (state: unknown) => unknown) =>
    selector({
      searchSources: { anysearch: { enabled: false } },
      setSearchSources: vi.fn(),
    }),
}));

vi.mock("./Markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-markdown-preview": true }, children),
}));

vi.mock("./ModelSelectPill", () => ({
  ModelSelectPill: () => React.createElement("div", { "data-model-select": true }),
}));

vi.mock("./ContextRing", () => ({
  ContextRing: () => React.createElement("div", { "data-context-ring": true }),
}));

vi.mock("./Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import { ChatComposer } from "./ChatComposer";

const baseProps = {
  onValueChange: vi.fn(),
  onSend: vi.fn(),
  onKeyDown: vi.fn(),
  onPaste: vi.fn(),
  onAttach: vi.fn(),
  onDropFiles: vi.fn(),
  busy: false,
  placeholder: "Ask",
  attachments: [],
  onRemoveAttachment: vi.fn(),
  models: [{ id: "model" }],
  currentModel: "model",
  onModelChange: vi.fn(),
  conversationId: "conversation",
  systemPrompt: "system",
};

describe("ChatComposer math preview", () => {
  it("renders a labeled preview for a multiline display formula", async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        React.createElement(ChatComposer, {
          ...baseProps,
          value: "那么：\n$$\\frac{q^\\top k}{\\sqrt d}\n= \\sqrt d \\cos\\theta.$$",
        }),
      );
    });

    const preview = tree!.root.findByProps({ "aria-label": "Formula preview" });
    expect(preview.props["aria-live"]).toBe("polite");
    expect(tree!.root.findByProps({ "data-markdown-preview": true }).children.join(""))
      .toContain("\\frac{q^\\top k}{\\sqrt d}");
  });

  it("does not add preview chrome for ordinary prose", async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(React.createElement(ChatComposer, { ...baseProps, value: "ordinary question" }));
    });

    expect(tree!.root.findAllByProps({ "aria-label": "Formula preview" })).toHaveLength(0);
  });
});
