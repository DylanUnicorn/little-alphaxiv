"""Mock OpenAI-compatible streaming server for E2E testing without a real key.

Runs on http://127.0.0.1:5050/v1. Emulates /chat/completions streaming:

  Turn 1 (no tool results yet): emits a search_arxiv tool_call.
  Turn 2 (messages include a tool result): streams a markdown-rich answer
            referencing the papers, with code blocks + lists + bold so we can
            verify the frontend's markdown renderer.

Usage:
    python mock_llm.py
Then in the app Settings, add provider:
    base_url = http://127.0.0.1:5050/v1
    api_key  = mock
    model    = mock-model
"""
from __future__ import annotations

import json
import time

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

app = FastAPI()


def _has_tool_result(messages: list) -> bool:
    return any(m.get("role") == "tool" for m in messages)


def _is_title_request(messages: list) -> bool:
    """The frontend's title generator sends a system prompt containing the
    phrase 'title generator'. Detect it so the mock returns a canned short
    title instead of a search_arxiv tool_call (which is the default turn-1
    behavior and would be wrong for a title request)."""
    for m in messages:
        c = m.get("content")
        if isinstance(c, str) and "title generator" in c.lower():
            return True
    return False


def _is_paper_title_request(messages: list) -> bool:
    """The paper-chat title prompt includes a 'Paper being discussed:' block
    (arxiv id + title + abstract + excerpt). Detect it so the mock returns a
    paper-specific canned title, distinct from the general-chat title, which
    lets the verification script tell the two apart."""
    for m in messages:
        c = m.get("content")
        if isinstance(c, str) and "paper being discussed" in c.lower():
            return True
    return False


_MOCK_TITLE_GENERAL = "Vision transformer paper search"
_MOCK_TITLE_PAPER = "Attention mechanism in transformers"


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)

    if _is_title_request(messages):
        # Title-generation request: return a short canned title. Paper chats
        # get a distinct title so verification can tell them apart from
        # general chats.
        title = _MOCK_TITLE_PAPER if _is_paper_title_request(messages) else _MOCK_TITLE_GENERAL
        if not stream:
            return JSONResponse(
                {
                    "id": "chatcmpl-mock-title",
                    "object": "chat.completion",
                    "model": "mock-model",
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": title}, "finish_reason": "stop"}
                    ],
                }
            )

        async def gen_title():
            yield _sse({"choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]})
            yield _sse({"choices": [{"index": 0, "delta": {"content": title}, "finish_reason": None}]})
            yield _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen_title(), media_type="text/event-stream")

    if not _has_tool_result(messages):
        # Turn 1: emit a search_arxiv tool call.
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
                                            "arguments": json.dumps(
                                                {"query": "vision transformer", "max_results": 5}
                                            ),
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
            # first chunk: tool call header
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
            # stream the arguments in pieces
            args = json.dumps({"query": "vision transformer", "max_results": 5})
            for i in range(0, len(args), 12):
                yield _sse(
                    {
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "tool_calls": [
                                        {"index": 0, "function": {"arguments": args[i : i + 12]}}
                                    ]
                                },
                                "finish_reason": None,
                            }
                        ]
                    }
                )
                time.sleep(0.01)
            yield _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]})
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen_tool(), media_type="text/event-stream")

    # Turn 2: stream a markdown-rich final answer.
    md = (
        "Here are some relevant papers I found:\n\n"
        "**Key findings:**\n\n"
        "1. Vision Transformers (ViT) split images into patches and process them with self-attention.\n"
        "2. `attention is all you need` introduced the transformer architecture.\n"
        "3. Swin Transformer uses *shifted windows* for hierarchical features.\n\n"
        "```python\n"
        "# minimal attention\n"
        "attn = softmax(Q @ K.T / sqrt(d)) @ V\n"
        "```\n\n"
        "> These results generalize across modalities.\n\n"
        "Click any paper card on the left to preview its PDF and chat about it. "
        "Ask me to *compare two papers* or *explain the math* and I'll go deeper."
    )

    if not stream:
        return JSONResponse(
            {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": "mock-model",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": md}, "finish_reason": "stop"}
                ],
            }
        )

    async def gen_text():
        # stream content in word-ish chunks
        chunks = [md[i : i + 8] for i in range(0, len(md), 8)]
        yield _sse({"choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]})
        for c in chunks:
            yield _sse({"choices": [{"index": 0, "delta": {"content": c}, "finish_reason": None}]})
            time.sleep(0.005)
        yield _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen_text(), media_type="text/event-stream")


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=5050, log_level="warning")
