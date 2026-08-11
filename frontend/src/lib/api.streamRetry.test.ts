import { afterEach, describe, expect, it, vi } from "vitest";

import { streamChat } from "./api";
import type { Provider } from "../types";

const provider = {
  id: "provider-1",
  name: "Test",
  base_url: "https://example.invalid/v1",
  api_key: "test…test",
  model: "test-model",
  api_format: "responses",
} as Provider;

function sseResponse(...events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function proxyConnectError(): Response {
  return sseResponse({
    error: true,
    error_type: "ConnectError",
    retryable: true,
    message: "upstream stream error (ConnectError): ConnectError",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("streamChat reconnect", () => {
  it("reconnects once when the proxy reports a connection failure before progress", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(proxyConnectError())
      .mockResolvedValueOnce(sseResponse({
        choices: [{ delta: { content: "Recovered" }, finish_reason: "stop" }],
      }));
    vi.stubGlobal("fetch", fetchMock);
    const onReconnect = vi.fn();
    const onDelta = vi.fn();

    const resultPromise = streamChat({ provider, messages: [], onReconnect, onDelta });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledWith(2, 2);
    expect(onDelta).toHaveBeenCalledWith("Recovered");
    expect(result.content).toBe("Recovered");
  });

  it("reconnects when the browser temporarily cannot reach the Docker backend", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(sseResponse({
        choices: [{ delta: { content: "Backend recovered" }, finish_reason: "stop" }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = streamChat({ provider, messages: [] });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("Backend recovered");
  });

  it("does not replay a request after assistant content has started", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(
      { choices: [{ delta: { content: "Partial" }, finish_reason: null }] },
      {
        error: true,
        error_type: "ReadError",
        retryable: true,
        message: "upstream stream error (ReadError): reset",
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamChat({ provider, messages: [] })).rejects.toThrow("ReadError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces structured proxy error bodies without crashing the SSE parser", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse({
      error: true,
      retryable: false,
      status: 400,
      body: {
        error: {
          message: "Invalid request payload",
          type: "invalid_request_error",
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamChat({ provider, messages: [] })).rejects.toThrow(
      'upstream error 400: {"error":{"message":"Invalid request payload","type":"invalid_request_error"}}',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamChat({ provider, messages: [], signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the second connection failure after one reconnect", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(proxyConnectError())
      .mockResolvedValueOnce(proxyConnectError());
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = streamChat({ provider, messages: [] });
    const rejection = expect(resultPromise).rejects.toThrow("ConnectError");
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
