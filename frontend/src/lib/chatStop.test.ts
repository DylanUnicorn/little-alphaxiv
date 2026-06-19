import { describe, it, expect } from "vitest";
import { isAbortError } from "./chatStop";

describe("isAbortError", () => {
  it("returns true when the passed signal was aborted", () => {
    const c = new AbortController();
    c.abort();
    expect(isAbortError(c.signal, new Error("anything"))).toBe(true);
  });

  it("returns true when the error is a DOMException named AbortError, even with a non-aborted signal", () => {
    const c = new AbortController();
    // signal NOT aborted — simulate a fetch that threw AbortError for another reason
    const err = new DOMException("aborted", "AbortError");
    expect(isAbortError(c.signal, err)).toBe(true);
  });

  it("returns false for an unrelated error and a non-aborted signal", () => {
    const c = new AbortController();
    expect(isAbortError(c.signal, new Error("network down"))).toBe(false);
  });

  it("returns false when signal is null and error is not an AbortError", () => {
    expect(isAbortError(null, new Error("upstream 500"))).toBe(false);
  });

  it("returns true when signal is null but error is an AbortError DOMException", () => {
    expect(isAbortError(null, new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("does not throw on non-error / undefined thrown values", () => {
    expect(isAbortError(undefined, undefined)).toBe(false);
    expect(isAbortError(undefined, "string thrown")).toBe(false);
  });
});
