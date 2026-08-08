import { describe, expect, it } from "vitest";

import { buildStreamFailureMessage, userFacingStreamError } from "./chatFailure";

describe("buildStreamFailureMessage", () => {
  it("renders a failure before output only once", () => {
    expect(buildStreamFailureMessage("", "Connection failed")).toEqual({
      role: "assistant",
      content: "⚠️ Connection failed",
    });
  });

  it("preserves partial output and adds interruption detail", () => {
    expect(buildStreamFailureMessage("Partial answer", "Connection failed")).toEqual({
      role: "assistant",
      content: "Partial answer",
      ui: { error: "Response interrupted: Connection failed" },
    });
  });
});

describe("userFacingStreamError", () => {
  it("turns nested proxy ConnectError details into an actionable message", () => {
    expect(userFacingStreamError(
      "upstream error: upstream stream error (ConnectError): ConnectError",
      false,
    )).toBe(
      "Couldn't connect to the model service after retrying. Check Docker or the upstream provider, then try again.",
    );
  });

  it("explains that partial output was preserved after a read failure", () => {
    expect(userFacingStreamError("upstream stream error (ReadError): reset", true)).toContain(
      "Your partial response was kept",
    );
  });

  it("preserves non-connection provider errors", () => {
    expect(userFacingStreamError("upstream error 429: rate limited", false)).toBe(
      "upstream error 429: rate limited",
    );
  });
});
