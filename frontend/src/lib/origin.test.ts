import { describe, it, expect } from "vitest";
import {
  CANONICAL_HOST,
  siblingHost,
  isLoopbackDevOrigin,
  redirectTargetForCanonicalHost,
  shouldShowOriginBanner,
  siblingOriginUrl,
} from "./origin";

describe("isLoopbackDevOrigin", () => {
  it("true for localhost + http", () => {
    expect(isLoopbackDevOrigin("localhost", "http:")).toBe(true);
  });
  it("true for 127.0.0.1 + http", () => {
    expect(isLoopbackDevOrigin("127.0.0.1", "http:")).toBe(true);
  });
  it("false for localhost + https", () => {
    expect(isLoopbackDevOrigin("localhost", "https:")).toBe(false);
  });
  it("false for a real domain + https", () => {
    expect(isLoopbackDevOrigin("app.example.com", "https:")).toBe(false);
  });
});

describe("siblingHost", () => {
  it("maps 127.0.0.1 -> localhost", () => {
    expect(siblingHost("127.0.0.1")).toBe("localhost");
  });
  it("maps localhost -> 127.0.0.1", () => {
    expect(siblingHost("localhost")).toBe("127.0.0.1");
  });
  it("returns null for a non-loopback host", () => {
    expect(siblingHost("app.example.com")).toBeNull();
  });
});

describe("redirectTargetForCanonicalHost", () => {
  // Fires only from an EMPTY 127.0.0.1 over http. Never strands data.
  it("redirects empty 127.0.0.1 (http) to localhost with ?laxredir=1, port/path/hash preserved", () => {
    const target = redirectTargetForCanonicalHost(
      "127.0.0.1", "http:", /*hasHistory*/ false,
      "http://127.0.0.1:5173", "/paper/2401.00001", "?x=1", "#frag"
    );
    expect(target).toBe("http://localhost:5173/paper/2401.00001?x=1&laxredir=1#frag");
  });

  it("appends ?laxredir=1 when there is no existing query", () => {
    const target = redirectTargetForCanonicalHost(
      "127.0.0.1", "http:", false,
      "http://127.0.0.1:5174", "/", "", ""
    );
    expect(target).toBe("http://localhost:5174/?laxredir=1");
  });

  it("does NOT redirect when 127.0.0.1 HAS history (do not strand data)", () => {
    const target = redirectTargetForCanonicalHost(
      "127.0.0.1", "http:", /*hasHistory*/ true,
      "http://127.0.0.1:5173", "/", "", ""
    );
    expect(target).toBeNull();
  });

  it("does NOT redirect when already on localhost", () => {
    expect(
      redirectTargetForCanonicalHost("localhost", "http:", false, "http://localhost:5173", "/", "", "")
    ).toBeNull();
  });

  it("does NOT redirect over https", () => {
    expect(
      redirectTargetForCanonicalHost("127.0.0.1", "https:", false, "https://127.0.0.1:5173", "/", "", "")
    ).toBeNull();
  });

  it("does NOT redirect on a real domain", () => {
    expect(
      redirectTargetForCanonicalHost("app.example.com", "https:", false, "https://app.example.com", "/", "", "")
    ).toBeNull();
  });
});

describe("shouldShowOriginBanner", () => {
  it("shows banner on localhost (http) with no history, no laxredir, not dismissed", () => {
    expect(shouldShowOriginBanner("localhost", "http:", false, false, false)).toBe(true);
  });

  it("suppresses when hasHistory is true", () => {
    expect(shouldShowOriginBanner("localhost", "http:", true, false, false)).toBe(false);
  });

  it("suppresses when arriving via our own redirect (?laxredir=1)", () => {
    expect(shouldShowOriginBanner("localhost", "http:", false, true, false)).toBe(false);
  });

  it("suppresses when previously dismissed", () => {
    expect(shouldShowOriginBanner("localhost", "http:", false, false, true)).toBe(false);
  });

  it("never shows on 127.0.0.1 (redirect handles it, not the banner)", () => {
    expect(shouldShowOriginBanner("127.0.0.1", "http:", false, false, false)).toBe(false);
  });

  it("never shows on localhost over https (dev-only: http gate)", () => {
    expect(shouldShowOriginBanner("localhost", "https:", false, false, false)).toBe(false);
  });

  it("never shows on a real domain", () => {
    expect(shouldShowOriginBanner("app.example.com", "https:", false, false, false)).toBe(false);
  });
});

describe("siblingOriginUrl", () => {
  it("builds a full URL to the sibling loopback host, preserving port/path/hash", () => {
    const url = siblingOriginUrl("localhost", "http:", "5173", "/paper/2401.00001", "", "#frag");
    expect(url).toBe("http://127.0.0.1:5173/paper/2401.00001#frag");
  });

  it("returns null when not on a loopback dev origin", () => {
    expect(siblingOriginUrl("app.example.com", "https:", "443", "/", "", "")).toBeNull();
  });

  // Banner link deliberately carries NO laxredir so the sibling's own load()
  // treats it as a normal arrival (it may have data to show).
  it("never appends laxredir (target is a fresh arrival at the sibling)", () => {
    const url = siblingOriginUrl("localhost", "http:", "5173", "/", "?a=1", "");
    expect(url).toBe("http://127.0.0.1:5173/?a=1");
    expect(url).not.toContain("laxredir");
  });
});

describe("CANONICAL_HOST", () => {
  it("is localhost (matches what vite prints)", () => {
    expect(CANONICAL_HOST).toBe("localhost");
  });
});
