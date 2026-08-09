import React from "react";
import { act, create } from "react-test-renderer";
// @ts-expect-error Frontend sources intentionally omit Node typings; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactElement }) => children,
}));

import { UserMessageActions } from "./UserMessageActions";

describe("UserMessageActions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies canonical message text and exposes success feedback", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const tree = create(
      <UserMessageActions text={"Compare $q$ and $k$"} editDisabled={false} onEdit={vi.fn()} />,
    );
    const copy = tree.root.findByProps({ "aria-label": "Copy message" });

    await act(async () => copy.props.onClick());

    expect(writeText).toHaveBeenCalledWith("Compare $q$ and $k$");
    expect(tree.root.findByProps({ "aria-label": "Message copied" })).toBeTruthy();
  });

  it("keeps copy available but disables edit during generation", () => {
    const onEdit = vi.fn();
    const tree = create(
      <UserMessageActions text="Question" editDisabled onEdit={onEdit} />,
    );

    expect(tree.root.findByProps({ "aria-label": "Copy message" }).props.disabled).not.toBe(true);
    const edit = tree.root.findByProps({ "aria-label": "Edit message" });
    expect(edit.props.disabled).toBe(true);
  });

  it("renders Copy without an Edit action for non-editable messages", () => {
    const tree = create(<UserMessageActions text="Earlier question" />);

    expect(tree.root.findByProps({ "aria-label": "Copy message" })).toBeTruthy();
    expect(tree.root.findAllByProps({ "aria-label": "Edit message" })).toHaveLength(0);
  });

  it("has hover, keyboard-focus, and touch visibility contracts", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.msg-user:hover\s+\.user-message-actions/);
    expect(css).toMatch(/\.msg-user:focus-within\s+\.user-message-actions/);
    expect(css).toMatch(/@media\s*\(hover:\s*none\)/);
  });
});
