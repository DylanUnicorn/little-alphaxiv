import { describe, expect, it } from "vitest";
import type { Provider } from "../types";

describe("Provider API format", () => {
  it("allows a Responses API provider", () => {
    const provider: Provider = {
      id: "responses-provider",
      name: "Responses gateway",
      base_url: "https://gateway.example/v1",
      api_key: "masked",
      model: "gpt-4.1-mini",
      api_format: "responses",
    };

    expect(provider.api_format).toBe("responses");
  });
});
