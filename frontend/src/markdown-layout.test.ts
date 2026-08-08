// @ts-expect-error Frontend sources intentionally omit Node typings; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./index.css", import.meta.url), "utf8");

describe("assistant markdown blockquote layout", () => {
  it("keeps the outer text spacing vertically balanced", () => {
    expect(stylesheet).toMatch(
      /\.msg-assistant blockquote\s*{[^}]*padding:\s*8px 13px;/s,
    );
    expect(stylesheet).toMatch(
      /\.msg-assistant blockquote\s*>\s*:first-child\s*{\s*margin-top:\s*0;\s*}/,
    );
    expect(stylesheet).toMatch(
      /\.msg-assistant blockquote\s*>\s*:last-child\s*{\s*margin-bottom:\s*0;\s*}/,
    );
  });
});

describe("user message markdown layout", () => {
  it("uses normal Markdown whitespace and scrolls wide display math", () => {
    expect(stylesheet).toMatch(/\.msg-user\s*{[^}]*white-space:\s*normal;/s);
    expect(stylesheet).toMatch(
      /\.msg-user \.katex-display\s*{[^}]*overflow-x:\s*auto;/s,
    );
  });
});

describe("composer math preview layout", () => {
  it("bounds long previews and scrolls wide display math", () => {
    expect(stylesheet).toMatch(
      /\.composer-markdown-preview-body\s*{[^}]*max-height:\s*160px;[^}]*overflow-y:\s*auto;/s,
    );
    expect(stylesheet).toMatch(
      /\.composer-markdown-preview \.katex-display\s*{[^}]*overflow-x:\s*auto;/s,
    );
  });
});
