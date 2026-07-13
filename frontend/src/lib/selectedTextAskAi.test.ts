import { describe, expect, it } from "vitest";
import {
  buildSelectedTextMessage,
  findSelectedPdfPage,
  normalizeSelectedText,
  pendingContextForConversation,
  selectedPdfTextPayload,
  visibleSelectedTextPayload,
} from "./selectedTextAskAi";

describe("selected PDF text prompts", () => {
  it("normalizes a PDF excerpt and limits its length", () => {
    expect(normalizeSelectedText("  A\n\n  B\tC  ", 100)).toBe("A B C");
    expect(normalizeSelectedText("abcdefgh", 5)).toBe("abcde…");
  });

  it("builds a page-grounded message with the user's custom prompt", () => {
    expect(buildSelectedTextMessage({ text: "a useful result", pageNumber: 4 }, "Why?")).toBe(
      "Excerpt from page 4:\n\n> a useful result\n\nWhy?"
    );
  });

  it("quotes every excerpt line and supplies a default question", () => {
    expect(buildSelectedTextMessage({ text: "line one\nline two", pageNumber: 2 }, "")).toBe(
      "Excerpt from page 2:\n\n> line one\n> line two\n\nPlease explain this excerpt."
    );
  });

  it("accepts text inside a numbered PDF page and rejects other elements", () => {
    expect(findSelectedPdfPage({ closest: () => ({ dataset: { pageNumber: "7" } }) } as unknown as Element)).toBe(7);
    expect(findSelectedPdfPage({ closest: () => null } as unknown as Element)).toBeNull();
  });

  it("keeps only a non-empty selection from one PDF page", () => {
    expect(selectedPdfTextPayload("  useful\ntext ", 3, 3)).toEqual({ text: "useful text", pageNumber: 3 });
    expect(selectedPdfTextPayload("useful text", 3, 4)).toBeNull();
    expect(selectedPdfTextPayload("   ", 3, 3)).toBeNull();
  });

  it("keeps selected-text context bound to the conversation that attached it", () => {
    const pending = {
      conversationId: "paper-thread-a",
      context: { text: "a useful result", pageNumber: 4 },
    };
    expect(pendingContextForConversation(pending, "paper-thread-a")).toEqual(pending.context);
    expect(pendingContextForConversation(pending, "paper-thread-b")).toBeNull();
  });

  it("hides a captured selection as soon as Ask AI is disabled", () => {
    const payload = { text: "useful text", pageNumber: 3 };
    expect(visibleSelectedTextPayload(payload, false)).toEqual(payload);
    expect(visibleSelectedTextPayload(payload, true)).toBeNull();
  });
});
