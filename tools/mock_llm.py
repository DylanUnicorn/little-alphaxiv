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


def _estimate_prompt_tokens(messages: list) -> int:
    """Rough chars-to-tokens estimate of the request, ~1.1x the frontend's
    heuristic so the derived calibration factor is != 1.0 (a real provider's
    count never exactly matches the client estimate). Proportional to the
    request, so a 120K-char turn reports ~33K prompt_tokens (not a fixed 4242)
    — keeping calibration near 1.0 and the ring's truncation honest. Counts
    text in string content and multimodal text parts."""
    total = 0
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            total += len(c)
        elif isinstance(c, list):
            for p in c:
                if isinstance(p, dict) and p.get("type") == "text":
                    total += len(p.get("text") or "")
    return max(1, int(total / 4 * 1.1))


@app.get("/v1/models")
async def list_models():
    """Models listing. One entry reports context_length (exercises the
    frontend's "detected" capacity path), one does not (exercises the curated
    fallback). The frontend's fetchModels picks context_length off each entry
    instead of discarding it."""
    return {
        "object": "list",
        "data": [
            {
                "id": "zai-org/glm-5.2",
                "object": "model",
                "created": 1700000000,
                "owned_by": "zai-org",
                "context_length": 128000,
            },
            {
                "id": "mock-model",
                "object": "model",
                "created": 1700000000,
                "owned_by": "mock",
            },
        ],
    }


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    stream = body.get("stream", False)
    include_usage = bool((body.get("stream_options") or {}).get("include_usage"))

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
        # Final usage chunk (choices: []), emitted when the caller asked for it
        # via stream_options.include_usage — same shape OpenAI-compatible streams
        # use. prompt_tokens is a realistic count proportional to the request so
        # the frontend's calibration factor stays near 1.0 (and != 1.0 exactly,
        # since the mock's formula differs slightly from the client heuristic).
        if include_usage:
            prompt_tokens = _estimate_prompt_tokens(messages)
            completion_tokens = max(1, len(md) // 4)
            yield _sse(
                {
                    "choices": [],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_tokens + completion_tokens,
                    },
                }
            )
        yield "data: [DONE]\n\n"

    return StreamingResponse(gen_text(), media_type="text/event-stream")


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


if __name__ == "__main__":
    import os

    port = int(os.environ.get("MOCK_PORT", "5050"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
