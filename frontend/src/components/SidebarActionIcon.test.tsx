import { create } from "react-test-renderer";
// @ts-expect-error Frontend sources intentionally omit Node typings; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SidebarActionIcon } from "./SidebarActionIcon";

function renderIcon(name: "open-paper" | "settings") {
  return create(<SidebarActionIcon name={name} />).root;
}

describe("SidebarActionIcon", () => {
  it.each(["open-paper", "settings"] as const)(
    "renders the %s variant with the shared theme-aware line style",
    (name) => {
      const svg = renderIcon(name).findByType("svg");

      expect(svg.props).toMatchObject({
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        focusable: "false",
      });
      expect(svg.props.className).toContain("sidebar-action-icon");
      expect(svg.props.className).toContain("sidebar-action-icon--" + name);
    },
  );

  it("draws Open Paper as a document with an add mark", () => {
    const root = renderIcon("open-paper");
    const paths = root.findAllByType("path").map((node) => node.props.d);

    expect(paths).toContain("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
    expect(paths).toContain("M14 2v6h6");
    expect(paths).toContain("M9 15h6");
    expect(paths).toContain("M12 12v6");
  });

  it("draws Settings as a gear with a distinct center", () => {
    const root = renderIcon("settings");

    expect(root.findAllByType("path")).toHaveLength(1);
    expect(root.findAllByType("circle").map((node) => node.props)).toContainEqual(
      expect.objectContaining({ cx: "12", cy: "12", r: "3" }),
    );
  });

  it("keeps both SVG variants centered in the existing collapsed button", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.sidebar-collapsed \.icon-btn\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*padding:\s*0;/s,
    );
    expect(css).toMatch(
      /\.sidebar-action-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*flex:\s*none;/s,
    );
  });
});
