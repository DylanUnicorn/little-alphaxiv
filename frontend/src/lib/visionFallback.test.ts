import { describe, it, expect } from "vitest";
import {
  isVisionCapable,
  resolveVisionFallback,
  VISION_CAPABLE,
} from "./visionFallback";

describe("isVisionCapable", () => {
  it("matches known vision-capable model ids", () => {
    expect(isVisionCapable("gpt-4o")).toBe(true);
    expect(isVisionCapable("gpt-4o-mini")).toBe(true);
    expect(isVisionCapable("gpt-4.1")).toBe(true);
    expect(isVisionCapable("gpt-4.1-mini")).toBe(true);
    expect(isVisionCapable("gpt-4-turbo")).toBe(true);
    expect(isVisionCapable("gemini-2.0-flash")).toBe(true);
    expect(isVisionCapable("claude-3-5-sonnet")).toBe(true);
    expect(isVisionCapable("claude-sonnet-4-6")).toBe(true);
    expect(isVisionCapable("glm-4v")).toBe(true);
    expect(isVisionCapable("qwen2-vl-7b")).toBe(true);
    expect(isVisionCapable("llava-1.5-7b")).toBe(true);
  });

  it("returns false for text-only model ids", () => {
    expect(isVisionCapable("gpt-3.5-turbo")).toBe(false);
    expect(isVisionCapable("glm-5.2")).toBe(false);
    expect(isVisionCapable("deepseek-chat")).toBe(false);
    expect(isVisionCapable("qwen-7b")).toBe(false);
    expect(isVisionCapable("mistral-7b")).toBe(false);
  });

  it("returns false for empty / undefined / null (treats unknown as non-vision)", () => {
    expect(isVisionCapable("")).toBe(false);
    expect(isVisionCapable(undefined)).toBe(false);
    expect(isVisionCapable(null)).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isVisionCapable("GPT-4O")).toBe(true);
    expect(isVisionCapable("Gemini-2.0")).toBe(true);
  });

  it("table lists more-specific patterns before shorter ones", () => {
    // gpt-4.1 must be present and matchable; a bare "gpt-4" (which would also
    // match the non-vision gpt-4 base) is intentionally NOT in the table so
    // only the vision-capable gpt-4.x variants match.
    const matches = VISION_CAPABLE.map((e) => e.match);
    expect(matches).toContain("gpt-4.1");
    expect(matches).not.toContain("gpt-4");
  });
});

describe("resolveVisionFallback", () => {
  it("swaps when image present, current is non-vision, visionModel set and different", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-3.5-turbo",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: true, model: "gpt-4o" });
  });

  it("does NOT swap when current model is already vision-capable", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-4o",
      visionModel: "gpt-4o-mini",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-4o" });
  });

  it("does NOT swap when no visionModel is configured", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-3.5-turbo",
      visionModel: undefined,
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-3.5-turbo" });
  });

  it("does NOT swap when visionModel is empty string", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-3.5-turbo",
      visionModel: "",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-3.5-turbo" });
  });

  it("does NOT swap when no image is present", () => {
    const r = resolveVisionFallback({
      hasImage: false,
      currentModel: "gpt-3.5-turbo",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-3.5-turbo" });
  });

  it("does NOT swap when current === visionModel (idempotent)", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "gpt-4o",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: false, model: "gpt-4o" });
  });

  it("swaps when current is an unknown model (unknown = non-vision)", () => {
    const r = resolveVisionFallback({
      hasImage: true,
      currentModel: "some-obscure-text-model",
      visionModel: "gpt-4o",
    });
    expect(r).toEqual({ shouldSwap: true, model: "gpt-4o" });
  });
});
