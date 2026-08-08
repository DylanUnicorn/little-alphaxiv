// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MathfieldElement } from "mathlive";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mathlive", () => {
  class MockMathfieldElement extends HTMLElement {
    private latex = "";
    mathVirtualKeyboardPolicy = "auto";
    menuItems: readonly unknown[] = [];
    smartFence = true;
    readOnly = false;
    position = 0;
    lastOffset = 0;

    connectedCallback() {
      this.latex = this.textContent ?? "";
      this.lastOffset = this.latex.length;
    }

    getValue() {
      return this.latex;
    }

    setValue(value = "") {
      this.latex = value;
      this.lastOffset = value.length;
      this.textContent = value;
    }
  }

  if (!customElements.get("math-field")) {
    customElements.define("math-field", MockMathfieldElement);
  }
  return { MathfieldElement: MockMathfieldElement };
});

vi.mock("../store/settings", () => ({
  useSettings: (selector: (state: unknown) => unknown) =>
    selector({
      searchSources: { anysearch: { enabled: false } },
      setSearchSources: vi.fn(),
    }),
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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const baseProps = {
  onValueChange: vi.fn(),
  onSend: vi.fn(),
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

describe("ChatComposer editable math surface", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(value: string, overrides: Partial<typeof baseProps> = {}) {
    await act(async () => {
      root.render(<ChatComposer {...baseProps} {...overrides} value={value} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders prose and an editable formula in one surface without Preview", async () => {
    await render("求 $\\frac{a}{b}$ 的值");

    expect(container.querySelectorAll('[role="textbox"]')).toHaveLength(1);
    expect(container.querySelector("math-field")).not.toBeNull();
    expect(container.querySelector('[aria-label="Formula preview"]')).toBeNull();
    expect(container.textContent).not.toContain("Preview");
  });

  it("synchronizes a genuinely different external draft without emitting a loop", async () => {
    await render("first $x$");
    expect(container.querySelector("math-field")?.textContent).toContain("x");

    await render("second $$y^2$$");

    expect(container.querySelector(".composer-math-node")?.getAttribute("data-display")).toBe("true");
    expect(container.querySelector("math-field")?.textContent).toContain("y^2");
    expect(baseProps.onValueChange).not.toHaveBeenCalled();
  });

  it("serializes edits made inside the visual formula", async () => {
    await render("$x$");
    const mathfield = container.querySelector<MathfieldElement>("math-field");
    expect(mathfield).not.toBeNull();

    await act(async () => {
      mathfield!.setValue("x^3", { silenceNotifications: true });
      mathfield!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(baseProps.onValueChange).toHaveBeenLastCalledWith("$x^3$");
  });

  it("sends on Enter and inserts a newline on Shift+Enter", async () => {
    await render("hello");
    const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!;

    await act(async () => {
      textbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(baseProps.onSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      textbox.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
      }));
    });
    const calls = baseProps.onValueChange.mock.calls;
    const newlineValue = calls[calls.length - 1]?.[0];
    expect(newlineValue).toContain("hello");
    expect(newlineValue).toContain("\n");
  });

  it("converts formulas in mixed clipboard text while preserving prose", async () => {
    await render("");
    const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [],
        getData: (type: string) => type === "text/plain" ? "注意 $\\sqrt{x}$。" : "",
      },
    });

    await act(async () => textbox.dispatchEvent(paste));

    expect(container.querySelector("math-field")).not.toBeNull();
    expect(baseProps.onValueChange).toHaveBeenLastCalledWith("注意 $\\sqrt{x}$。");
  });

  it("disables prose and formula editing while generation is busy", async () => {
    await render("$x$", { busy: true });

    expect(container.querySelector('[role="textbox"]')?.getAttribute("contenteditable")).toBe("false");
    expect(container.querySelector<MathfieldElement>("math-field")?.readOnly).toBe(true);
  });
});
