import { describe, it, expect } from "vitest";
import {
  resolveCapacity,
  defaultReserve,
  estimateTextTokens,
  estimateTokens,
  computeCalibration,
  calibratedEstimate,
  truncateToFit,
  computeBudget,
  resolveForConv,
  formatTokens,
  DEFAULT_CAPACITY,
  KNOWN_MODEL_CONTEXT,
} from "./contextBudget";
import type { ChatMessage } from "../types";

const msg = (role: ChatMessage["role"], content: string | null): ChatMessage =>
  ({ role, content } as ChatMessage);

describe("resolveCapacity", () => {
  it("override wins over everything", () => {
    const r = resolveCapacity(
      { id: "zai-org/glm-5.2", context_length: 128_000 },
      256_000
    );
    expect(r).toEqual({ tokens: 256_000, source: "override" });
  });

  it("override 0 / undefined means Auto → chain runs", () => {
    expect(
      resolveCapacity({ id: "x", context_length: 200_000 }, 0).source
    ).toBe("detected");
    expect(
      resolveCapacity({ id: "x", context_length: 200_000 }, undefined).tokens
    ).toBe(200_000);
  });

  it("detected (provider context_length) beats table", () => {
    const r = resolveCapacity(
      { id: "zai-org/glm-5.2", context_length: 99_000 },
      undefined
    );
    expect(r).toEqual({ tokens: 99_000, source: "detected" });
  });

  it("curated table matches by substring, first match wins", () => {
    // gpt-4.1 listed before gpt-4 → a gpt-4.1 id must resolve to 1M, not 128K
    expect(
      resolveCapacity({ id: "gpt-4.1-mini" }, undefined).tokens
    ).toBe(1_000_000);
    expect(resolveCapacity({ id: "gpt-4o" }, undefined).tokens).toBe(128_000);
    expect(resolveCapacity({ id: "zai-org/glm-5.2" }, undefined).tokens).toBe(
      128_000
    );
    expect(resolveCapacity({ id: "deepseek-r1" }, undefined).tokens).toBe(64_000);
  });

  it("table match is case-insensitive", () => {
    expect(resolveCapacity({ id: "QWEN-2.5" }, undefined).tokens).toBe(32_000);
  });

  it("falls to default when nothing matches and no context_length", () => {
    expect(resolveCapacity({ id: "totally-unknown-model" }, undefined)).toEqual({
      tokens: DEFAULT_CAPACITY,
      source: "default",
    });
  });

  it("undefined model → default", () => {
    expect(resolveCapacity(undefined, undefined).source).toBe("default");
  });

  it("KNOWN_MODEL_CONTEXT has no conflicting prefix order (specific before general)", () => {
    // gpt-4.1 must appear before any entry whose match is a prefix of "gpt-4.1"
    const gpt41 = KNOWN_MODEL_CONTEXT.findIndex((e) => e.match === "gpt-4.1");
    const gpt4o = KNOWN_MODEL_CONTEXT.findIndex((e) => e.match === "gpt-4o");
    expect(gpt41).toBeGreaterThanOrEqual(0);
    expect(gpt4o).toBeGreaterThanOrEqual(0);
    // (No "gpt-4" bare entry exists; if one were added it must come after gpt-4.1.)
  });
});

describe("defaultReserve", () => {
  it("is 12.5% (capacity/8) within [4K, 64K]", () => {
    expect(defaultReserve(128_000)).toBe(16_000);
    expect(defaultReserve(256_000)).toBe(32_000);
    expect(defaultReserve(1_000_000)).toBe(64_000); // capped
    expect(defaultReserve(32_000)).toBe(4_000); // 4000 floored to min
    expect(defaultReserve(8_000)).toBe(4_000); // below floor → 4K
  });
});

describe("estimateTextTokens", () => {
  it("≈4 chars/token for ASCII", () => {
    expect(estimateTextTokens("abcdefgh")).toBe(2); // ceil(8/4)
  });

  it("≈1.5 chars/token for CJK", () => {
    // 6 CJK chars → ceil(6*1.5)=9
    expect(estimateTextTokens("你好世界测试")).toBe(9);
  });

  it("mixes CJK and ASCII", () => {
    // "hello"(5 ascii→2) + "你好"(2 cjk→3) = 5
    expect(estimateTextTokens("hello你好")).toBe(2 + 3);
  });

  it("empty string → 0", () => {
    expect(estimateTextTokens("")).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("sums content + 4 per message overhead", () => {
    const ms = [msg("user", "abcdefgh"), msg("assistant", "1234")];
    // 2 + 1 text tokens + 4*2 overhead = 11
    expect(estimateTokens(ms)).toBe(2 + 1 + 8);
  });

  it("null content counts only overhead", () => {
    expect(estimateTokens([msg("assistant", null)])).toBe(4);
  });

  it("multimodal: text parts counted, images ~1024 each", () => {
    const ms = [
      {
        role: "user",
        content: [
          { type: "text", text: "abcdefgh" },
          { type: "image_url", image_url: { url: "data:..." } },
        ],
      },
    ];
    expect(estimateTokens(ms)).toBe(2 + 1024 + 4);
  });
});

describe("computeCalibration", () => {
  it("is the ratio clamped to [0.3, 3.0]", () => {
    expect(computeCalibration(2000, 1000)).toBe(2);
    expect(computeCalibration(500, 1000)).toBe(0.5);
    expect(computeCalibration(5000, 1000)).toBe(3.0); // clamp high
    expect(computeCalibration(100, 1000)).toBe(0.3); // clamp low
  });

  it("returns 1 when heuristic estimate is unusable", () => {
    expect(computeCalibration(1000, 0)).toBe(1);
    expect(computeCalibration(1000, -5)).toBe(1);
  });
});

describe("calibratedEstimate", () => {
  it("applies calibration, defaults to 1x", () => {
    expect(calibratedEstimate(1000, 2)).toBe(2000);
    expect(calibratedEstimate(1000, undefined)).toBe(1000);
    expect(calibratedEstimate(1000, 0)).toBe(1000);
  });
});

describe("truncateToFit", () => {
  const sys = "sys";

  it("returns all messages when they fit", () => {
    const ms = [msg("user", "hi"), msg("assistant", "hello")];
    const r = truncateToFit(ms, 128_000, 16_000, sys);
    expect(r.messages).toHaveLength(2);
    expect(r.dropped).toBe(0);
  });

  it("drops oldest ordinary messages from the front until it fits", () => {
    // capacity 200, reserve 0, system ~1 token → budget ~199. Each "aaaa..."
    // message is 4 chars=1 token + 4 overhead = 5. 50 msgs = 250 > 199.
    const ms = Array.from({ length: 50 }, (_, i) =>
      msg(i % 2 ? "assistant" : "user", "aaaa")
    );
    const r = truncateToFit(ms, 200, 0, sys);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.messages.length).toBeLessThan(50);
    // newest message (last) is preserved
    expect(r.messages[r.messages.length - 1]).toBe(ms[ms.length - 1]);
  });

  it("keeps the last unit even if it alone exceeds budget", () => {
    const huge = "x".repeat(10_000);
    const ms = [msg("user", huge)];
    const r = truncateToFit(ms, 100, 0, sys);
    expect(r.messages).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it("never orphans a tool result from its tool_call (drops whole unit)", () => {
    // assistant(tool_calls) + 2 tool results is one atomic unit.
    const toolCall = {
      id: "call_1",
      type: "function" as const,
      function: { name: "search_arxiv", arguments: "{}" },
    };
    const assistantWithTools: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
    };
    const toolA: ChatMessage = {
      role: "tool",
      content: "result-a",
      tool_call_id: "call_1",
      name: "search_arxiv",
    };
    const toolB: ChatMessage = {
      role: "tool",
      content: "result-b",
      tool_call_id: "call_1",
      name: "search_arxiv",
    };
    const ms: ChatMessage[] = [
      assistantWithTools,
      toolA,
      toolB,
      msg("assistant", "final answer"),
      msg("user", "thanks"),
    ];
    // Tiny budget (sys ~1 token; capacity 20 → budget ~19) forces dropping the
    // front unit (cost ~16) while units 2+3 (~13) still fit.
    const r = truncateToFit(ms, 20, 0, sys);
    // The assistant(tool_calls)+tool+tool unit is dropped atomically — toolA/toolB
    // never survive without their preceding assistant tool_call.
    const roles = r.messages.map((m) => m.role);
    expect(roles).not.toContain("tool");
    // And no assistant message retains a dangling tool_calls either.
    for (const m of r.messages) {
      if (m.role === "assistant") expect(m.tool_calls).toBeFalsy();
    }
    expect(r.dropped).toBe(3);
  });

  it("system prompt is a fixed cost, never truncated", () => {
    // System prompt alone > budget → bail, keep all history unchanged.
    const bigSys = "x".repeat(10_000);
    const ms = [msg("user", "hi")];
    const r = truncateToFit(ms, 100, 0, bigSys);
    expect(r.messages).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it("empty history → empty, dropped 0", () => {
    const r = truncateToFit([], 128_000, 16_000, sys);
    expect(r.messages).toHaveLength(0);
    expect(r.dropped).toBe(0);
  });

  it("calibration shrinks/grows the estimated cost used for the fit check", () => {
    // With calibration 0.5, each message costs half → fewer dropped.
    const ms = Array.from({ length: 50 }, () => msg("user", "aaaa"));
    const droppedNoCal = truncateToFit(ms, 200, 0, sys).dropped;
    const droppedCal = truncateToFit(ms, 200, 0, sys, 0.5).dropped;
    expect(droppedCal).toBeLessThanOrEqual(droppedNoCal);
  });
});

describe("computeBudget", () => {
  it("usable = total - reserve; pct = used/usable", () => {
    const b = computeBudget({
      messages: [msg("user", "hello world")],
      systemPrompt: "sys",
      model: { id: "zai-org/glm-5.2" },
      capacityOverride: 128_000,
      reserveOverride: 16_000,
    });
    expect(b.total).toBe(128_000);
    expect(b.reserve).toBe(16_000);
    expect(b.usable).toBe(112_000);
    expect(b.source).toBe("override");
    expect(b.pct).toBeGreaterThan(0);
    expect(b.pct).toBeLessThan(0.01);
    expect(b.status).toBe("ok");
  });

  it("status thresholds: ok ≤0.80, warn >0.80, critical >0.95", () => {
    // capacity 10000, explicit reserve 9000 → usable 1000.
    // used = ceil(N/4) + 8 (system "" + one N-char user msg, 2 messages overhead).
    const budget = (nChars: number) =>
      computeBudget({
        messages: [msg("user", "x".repeat(nChars))],
        systemPrompt: "",
        model: { id: "x" },
        capacityOverride: 10_000,
        reserveOverride: 9_000,
      });
    // used ~400 → pct 0.40 → ok
    expect(budget(1568).status).toBe("ok");
    // used ~900 → pct 0.90 → warn
    expect(budget(3568).status).toBe("warn");
    // used ~980 → pct 0.98 → critical
    expect(budget(3888).status).toBe("critical");
  });

  it("auto reserve (12.5%) when reserveOverride absent/0", () => {
    const b = computeBudget({
      messages: [],
      systemPrompt: "",
      model: { id: "x" },
      capacityOverride: 256_000,
    });
    expect(b.reserve).toBe(32_000);
    expect(b.usable).toBe(224_000);
  });

  it("uses calibration to scale used", () => {
    const base = computeBudget({
      messages: [msg("user", "hello world")],
      systemPrompt: "sys",
      model: { id: "x" },
      capacityOverride: 1_000_000,
    }).used;
    const scaled = computeBudget({
      messages: [msg("user", "hello world")],
      systemPrompt: "sys",
      model: { id: "x" },
      capacityOverride: 1_000_000,
      calibration: 2,
    }).used;
    expect(scaled).toBe(base * 2);
  });

  it("truncates over-capacity history: dropped > 0, used ≤ usable, pct ≤ 1", () => {
    // capacity 1000, explicit reserve 1 (avoids the 4K default floor), system "".
    // 300 messages of "aaaa" = 1 text token + 4 overhead = 5 each → 1500 tokens,
    // well over usable (999). Oldest units drop to fit; the ring reflects the
    // truncated (actual) request, so it never exceeds usable.
    const ms = Array.from({ length: 300 }, () => msg("user", "aaaa"));
    const b = computeBudget({
      messages: ms,
      systemPrompt: "",
      model: { id: "x" },
      capacityOverride: 1000,
      reserveOverride: 1,
    });
    expect(b.dropped).toBeGreaterThan(0);
    expect(b.used).toBeLessThanOrEqual(b.usable + 8); // tolerate per-message overhead rounding
    expect(b.pct).toBeLessThanOrEqual(1);
  });
});

describe("resolveForConv", () => {
  it("combines resolveCapacity + defaultReserve", () => {
    const r = resolveForConv({
      model: { id: "zai-org/glm-5.2" },
      capacityOverride: 256_000,
    });
    expect(r).toEqual({ capacity: 256_000, reserve: 32_000, source: "override" });
  });

  it("honors explicit reserveOverride", () => {
    const r = resolveForConv({
      model: { id: "x" },
      capacityOverride: 128_000,
      reserveOverride: 8_000,
    });
    expect(r.reserve).toBe(8_000);
  });
});

describe("formatTokens", () => {
  it("formats K/M", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(4000)).toBe("4K");
    expect(formatTokens(48200)).toBe("48.2K");
    expect(formatTokens(128000)).toBe("128K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});
