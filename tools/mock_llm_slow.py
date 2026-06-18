"""Slow + droppable mock OpenAI-compatible streaming server for reproducing the
"stream interrupted when switching windows" bug.

Runs on http://127.0.0.1:5051/v1 (separate from tools/mock_llm.py on :5050 so
the standard rig keeps running). Behaves like mock_llm.py but:

  - Drips turn-2 content slowly (MOCK_DRIP_MS, default 120ms) so a test has time
    to background the page mid-stream.
  - If MOCK_DROP_AFTER=<n> env is set, the turn-2 stream closes the connection
    after <n> content chunks (simulating an interrupted / dropped upstream) to
    reproduce the partial-content symptom.

Turn 1 still emits a search_arxiv tool_call; turn 2 streams a markdown answer.
"""
from __future__ import annotations

import asyncio
import json
import os
import time

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

app = FastAPI()

DRIP_MS = float(os.environ.get("MOCK_DRIP_MS", "20"))
DROP_AFTER = int(os.environ["MOCK_DROP_AFTER"]) if os.environ.get("MOCK_DROP_AFTER") else None
# If set, after N content chunks send an SSE error event ({"error": true, ...})
# and close — this triggers the client's parseSSE throw path (a hard error, like
# a connection reset), distinct from MOCK_DROP_AFTER's clean close.
ERROR_AFTER = int(os.environ["MOCK_ERROR_AFTER"]) if os.environ.get("MOCK_ERROR_AFTER") else None

MD = (
    "Here are some relevant papers I found:\n\n"
    "**Key findings:**\n\n"
    "1. Vision Transformers (ViT) split images into patches and process them with self-attention.\n"
    "2. `attention is all you need` introduced the transformer architecture.\n"
    "3. Swin Transformer uses *shifted windows* for hierarchical features.\n\n"
    "Click any paper card to preview its PDF. The full answer must survive window switching."
)
# Repeat so the rendered answer overflows the chat scroll container (needed to
# exercise the auto-scroll stick-to-bottom behavior in scenario D).
MD = (MD + "\n\n") * 16


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


def _has_tool_result(messages: list) -> bool:
    return any(m.get("role") == "tool" for m in messages)


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    no_tool = bool(os.environ.get("MOCK_NO_TOOL"))

    if not no_tool and not _has_tool_result(messages):
        tool_call_id = "call_mock_1"
        if not stream:
            return JSONResponse(
                {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion",
                    "model": "mock-model",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": tool_call_id,
                                        "type": "function",
                                        "function": {
                                            "name": "search_arxiv",
                                            "arguments": json.dumps({"query": "vision transformer", "max_results": 5}),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                }
            )

        async def gen_tool():
            yield _sse(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": tool_call_id,
                                        "type": "function",
                                        "function": {"name": "search_arxiv", "arguments": ""},
                                    }
                                ],
                            },
                            "finish_reason": None,
                        }
                    ]
                }
            )
            args = json.dumps({"query": "vision transformer", "max_results": 5})
            for i in range(0, len(args), 12):
                yield _sse(
                    {
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"tool_calls": [{"index": 0, "function": {"arguments": args[i : i + 12]}}]},
                                "finish_reason": None,
                            }
                        ]
                    }
                )
                time.sleep(0.01)  # noqa: blocking; tiny and only in the tool-arg drip
            yield _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen_tool(), media_type="text/event-stream")

    # Turn 2: stream the markdown answer slowly.
    if not stream:
        return JSONResponse(
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": "mock-model",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": MD}, "finish_reason": "stop"}],
            }
        )

    async def gen_text():
        chunks = [MD[i : i + 8] for i in range(0, len(MD), 8)]
        yield _sse({"choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]})
        for n, c in enumerate(chunks):
            if DROP_AFTER is not None and n >= DROP_AFTER:
                # Simulate a dropped upstream: just stop yielding (clean close)
                # without [DONE] / finish_reason.
                return
            if ERROR_AFTER is not None and n >= ERROR_AFTER:
                # Simulate a hard upstream error mid-stream: emit an SSE error
                # event (the client's parseSSE treats json.error as a throw).
                yield _sse({"error": True, "status": 500, "message": "simulated upstream drop"})
                yield "data: [DONE]\n\n"
                return
            yield _sse({"choices": [{"index": 0, "delta": {"content": c}, "finish_reason": None}]})
            await asyncio.sleep(DRIP_MS / 1000.0)
        yield _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen_text(), media_type="text/event-stream")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=5051, log_level="warning")
