import { describe, it, expect } from "vitest";
import {
  gatherNoteEntries,
  renderNoteHtml,
  normArxiv,
  type TextResolver,
} from "./zoteroNote";
import type { Annotation } from "../types";

const emptyResolver: TextResolver = async () => "";

describe("normArxiv", () => {
  it("strips a trailing version suffix", () => {
    expect(normArxiv("2401.07041v2")).toBe("2401.07041");
    expect(normArxiv("2401.07041")).toBe("2401.07041");
    expect(normArxiv("  2401.07041v1 ")).toBe("2401.07041");
  });
});

describe("gatherNoteEntries", () => {
  it("uses captured highlight content, skips empty + draw", async () => {
    const annots: Annotation[] = [
      {
        id: "a1", arxiv_id: "x", page: 1, type: "highlight", color: "#FFEB3B",
        createdAt: 1, highlight: { rects: [{ x: 0, y: 0, w: 0.1, h: 0.02 }], content: "important" },
      },
      // no captured content, resolver returns "" -> skipped
      {
        id: "a2", arxiv_id: "x", page: 1, type: "highlight", color: "#FFEB3B",
        createdAt: 2, highlight: { rects: [{ x: 0, y: 0, w: 0.1, h: 0.02 }] },
      },
      {
        id: "a3", arxiv_id: "x", page: 2, type: "text", color: "#93C5FD",
        createdAt: 3, text: { x: 0, y: 0.5, w: 0.1, h: 0.02, content: "my note", fontSize: 10 },
      },
      // draw annotations have no text region -> skipped
      {
        id: "a4", arxiv_id: "x", page: 1, type: "draw", color: "#F9A8D4",
        createdAt: 4, draw: { points: [{ x: 0, y: 0 }], width: 1 },
      },
    ];
    const entries = await gatherNoteEntries(annots, emptyResolver);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe("important");
    expect(entries[0].page).toBe(1);
    expect(entries[0].kind).toBe("highlight");
    expect(entries[1].text).toBe("my note");
    expect(entries[1].page).toBe(2);
    expect(entries[1].kind).toBe("text");
  });

  it("recovers highlight text via resolver when no captured content", async () => {
    const resolver: TextResolver = async () => "recovered text";
    const annots: Annotation[] = [
      {
        id: "a1", arxiv_id: "x", page: 1, type: "highlight", color: "#FFEB3B",
        createdAt: 1, highlight: { rects: [{ x: 0, y: 0, w: 0.1, h: 0.02 }] },
      },
      // rect annotation also recovers via resolver
      {
        id: "a2", arxiv_id: "x", page: 1, type: "rect", color: "#A5F3A0",
        createdAt: 2, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
      },
    ];
    const entries = await gatherNoteEntries(annots, resolver);
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe("recovered text");
    expect(entries[1].kind).toBe("rect");
  });

  it("sorts by page then vertical position (reading order)", async () => {
    const annots: Annotation[] = [
      {
        id: "a1", arxiv_id: "x", page: 1, type: "text", color: "#FFEB3B",
        createdAt: 1, text: { x: 0, y: 0.8, w: 0.1, h: 0.02, content: "lower", fontSize: 10 },
      },
      {
        id: "a2", arxiv_id: "x", page: 1, type: "text", color: "#FFEB3B",
        createdAt: 2, text: { x: 0, y: 0.2, w: 0.1, h: 0.02, content: "upper", fontSize: 10 },
      },
      {
        id: "a3", arxiv_id: "x", page: 2, type: "text", color: "#FFEB3B",
        createdAt: 3, text: { x: 0, y: 0.1, w: 0.1, h: 0.02, content: "next page", fontSize: 10 },
      },
    ];
    const entries = await gatherNoteEntries(annots, emptyResolver);
    expect(entries.map((e) => e.text)).toEqual(["upper", "lower", "next page"]);
  });
});

describe("renderNoteHtml", () => {
  it("groups by page and escapes text", () => {
    const entries = [
      { page: 1, color: "#FFEB3B", text: "a <b>bold</b> move", kind: "highlight" as const, createdAt: 1, top: 0 },
      { page: 1, color: "#93C5FD", text: "note & more", kind: "text" as const, createdAt: 2, top: 0.5 },
      { page: 3, color: "#FFEB3B", text: "p3", kind: "highlight" as const, createdAt: 3, top: 0 },
    ];
    const html = renderNoteHtml({ title: "T", arxiv_id: "2401.07041" } as never, entries, 1_700_000_000_000);
    expect(html).toContain("Annotations — T");
    expect(html).toContain("Page 1");
    expect(html).toContain("Page 3");
    expect(html).not.toContain("Page 2");
    // HTML-escaped
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("note &amp; more");
    // text annotation rendered as a note paragraph
    expect(html).toContain("📝 Note:");
    // marker comment for secondary identification
    expect(html).toContain("little-alphaxiv-annotations-note");
  });

  it("falls back to arXiv:<id> title for a bare-id stub", () => {
    const html = renderNoteHtml(
      { title: "2401.07041", arxiv_id: "2401.07041" } as never,
      [],
      1_700_000_000_000
    );
    expect(html).toContain("Annotations — arXiv:2401.07041");
  });

  it("shows a placeholder when there are no entries", () => {
    const html = renderNoteHtml({ arxiv_id: "x" } as never, [], 1_700_000_000_000);
    expect(html).toContain("No annotations yet");
  });
});
