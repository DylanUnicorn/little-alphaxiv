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
