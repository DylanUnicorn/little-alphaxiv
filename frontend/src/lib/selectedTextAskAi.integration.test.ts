import { describe, expect, it } from "vitest";
import { consumePendingPrompt } from "./selectedTextAskAi";

describe("pending selected text prompts", () => {
  it("consumes one non-empty prompt only while the chat is idle", () => {
    expect(consumePendingPrompt("question", false)).toEqual({ prompt: "question", consumed: true });
    expect(consumePendingPrompt("", false)).toEqual({ prompt: null, consumed: false });
    expect(consumePendingPrompt("question", true)).toEqual({ prompt: null, consumed: false });
  });
});
