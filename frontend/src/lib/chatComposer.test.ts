import { describe, it, expect } from "vitest";
import { computeTextareaHeight } from "./chatComposer";

describe("computeTextareaHeight", () => {
  it("clamps below the minimum to the minimum", () => {
    expect(computeTextareaHeight(20, 60, 240)).toBe(60);
  });

  it("returns scrollHeight when within [min, max]", () => {
    expect(computeTextareaHeight(120, 60, 240)).toBe(120);
  });

  it("clamps above the maximum to the maximum", () => {
    expect(computeTextareaHeight(500, 60, 240)).toBe(240);
  });

  it("equals min when scrollHeight equals min", () => {
    expect(computeTextareaHeight(60, 60, 240)).toBe(60);
  });

  it("equals max when scrollHeight equals max", () => {
    expect(computeTextareaHeight(240, 60, 240)).toBe(240);
  });
});
