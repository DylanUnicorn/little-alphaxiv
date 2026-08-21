import { create } from "react-test-renderer";
// @ts-expect-error Frontend sources intentionally omit Node typings; Vitest runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SidebarActionIcon } from "./SidebarActionIcon";

type IconName =
  | "expand-sidebar"
  | "collapse-sidebar"
  | "new-chat"
  | "open-paper"
  | "settings"
  | "log-out";

function renderIcon(name: IconName) {
  return create(<SidebarActionIcon name={name} />).root;
}

describe("SidebarActionIcon", () => {
  it.each([
    "expand-sidebar",
    "collapse-sidebar",
    "new-chat",
    "open-paper",
    "settings",
    "log-out",
  ] as const)(
    "renders the %s variant with the shared theme-aware line style",
    (name) => {
      const svg = renderIcon(name).findByType("svg");

      expect(svg.props).toMatchObject({
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: name === "new-chat" ? 2.4 : 2,
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

  it("draws mirrored panel arrows for expand and collapse", () => {
    const expand = renderIcon("expand-sidebar");
    const collapse = renderIcon("collapse-sidebar");

    expect(expand.findByType("rect").props).toMatchObject({
      x: "3", y: "3", width: "18", height: "18", rx: "2",
    });
    expect(expand.findAllByType("path").map((node) => node.props.d)).toEqual([
      "M9 3v18",
      "m14 9 3 3-3 3",
    ]);
    expect(collapse.findAllByType("path").map((node) => node.props.d)).toEqual([
      "M9 3v18",
      "m16 9-3 3 3 3",
    ]);
  });

  it("draws New chat as a visually weighted centered plus", () => {
    const paths = renderIcon("new-chat")
      .findAllByType("path")
      .map((node) => node.props.d);

    expect(paths).toEqual(["M12 5v14", "M5 12h14"]);
  });

  it("draws Log out as a door with an outward arrow", () => {
    const paths = renderIcon("log-out")
      .findAllByType("path")
      .map((node) => node.props.d);

    expect(paths).toEqual([
      "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
      "m16 17 5-5-5-5",
      "M21 12H9",
    ]);
  });

  it("replaces the sidebar's remaining platform glyphs with SVG variants", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");

    expect(source).not.toContain(">»</button>");
    expect(source).not.toContain(">«</button>");
    expect(source).not.toContain("⚙ Settings");
    expect(source).not.toContain("⎋ Log out");
    for (const name of [
      "expand-sidebar",
      "collapse-sidebar",
      "new-chat",
      "settings",
      "log-out",
    ]) {
      expect(source).toContain('name="' + name + '"');
    }
  });

  it("keeps SVG actions centered at the right size for each sidebar context", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(css).toMatch(
      /\.icon-btn\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*padding:\s*0;/s,
    );
    expect(css).toMatch(
      /\.sidebar-action-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*flex:\s*none;/s,
    );
    expect(css).toMatch(
      /\.head-collapse \.sidebar-action-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;/s,
    );
    expect(css).toMatch(
      /\.settings-btn\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*gap:\s*7px;/s,
    );
    expect(css).toMatch(
      /\.settings-btn \.sidebar-action-icon\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px;/s,
    );
  });
});
