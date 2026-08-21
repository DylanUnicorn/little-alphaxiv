import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { SidebarConversationTypeIcon } from "./SidebarConversationTypeIcon";

describe("SidebarConversationTypeIcon", () => {
  it("renders distinct, decorative line drawings for chat and paper rows", () => {
    const general = create(<SidebarConversationTypeIcon type="general" />).root;
    const paper = create(<SidebarConversationTypeIcon type="paper" />).root;

    const generalWrap = general.findByType("span");
    const paperWrap = paper.findByType("span");
    expect(generalWrap.props.className).toBe("conv-type-icon general");
    expect(paperWrap.props.className).toBe("conv-type-icon paper");
    expect(generalWrap.props["aria-hidden"]).toBe(true);
    expect(paperWrap.props["aria-hidden"]).toBe(true);

    const generalSvg = general.findByType("svg");
    const paperSvg = paper.findByType("svg");
    expect(generalSvg.props.viewBox).toBe("0 0 24 24");
    expect(paperSvg.props.viewBox).toBe("0 0 24 24");
    expect(generalSvg.props.fill).toBe("none");
    expect(paperSvg.props.fill).toBe("none");

    const generalPaths = general.findAllByType("path").map((path) => path.props.d);
    const paperPaths = paper.findAllByType("path").map((path) => path.props.d);
    expect(generalPaths).not.toEqual(paperPaths);
    expect(generalPaths).toHaveLength(2);
    expect(paperPaths).toHaveLength(3);
  });
});
