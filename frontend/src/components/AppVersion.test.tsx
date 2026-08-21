import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAppVersion } from "../lib/api";
import { AppVersion } from "./AppVersion";


vi.mock("../lib/api", () => ({
  getAppVersion: vi.fn(),
}));


function text(renderer: ReactTestRenderer): string {
  return renderer.root.findByProps({ className: "app-version" }).children.join("");
}


describe("AppVersion", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a stable loading label while the runtime version is fetched", () => {
    vi.mocked(getAppVersion).mockReturnValue(new Promise(() => undefined));

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<AppVersion />);
    });

    expect(text(renderer)).toBe("Version ...");
  });

  it("shows the packaged runtime version", async () => {
    vi.mocked(getAppVersion).mockResolvedValue("0.1.4");

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AppVersion />);
    });

    expect(text(renderer)).toBe("Version v0.1.4");
  });

  it("stays non-blocking when version discovery fails", async () => {
    vi.mocked(getAppVersion).mockRejectedValue(new Error("offline"));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AppVersion />);
    });

    expect(text(renderer)).toBe("Version unavailable");
  });
});
