# Agent activity summary

**Date:** 2026-07-29

## Problem

Tool-using turns persist the OpenAI-compatible assistant/tool protocol in the
conversation history. The current renderer treats those protocol messages as
ordinary chat rows. Assistant messages that contain only `tool_calls` therefore
leave blank `16px` margins, while paper view hides paper-result cards without
removing their parent tool rows. A multi-round search visibly grows a large,
unexplained gap before the final answer.

The protocol messages are useful evidence. Removing them from storage would
hide what the agent did and would break the context sent back to the model.
They should instead be presented as one readable, low-noise activity record.

## Interaction design

Each contiguous tool loop between a user message and the assistant's final
answer renders as one `Agent activity` disclosure. It is open while the loop is
active so the latest search is visible, then automatically folds when the final
answer begins. Users can reopen it with the native disclosure control.

The folded row reports the number of tool calls and known results. The expanded
view lists calls chronologically with a friendly source label, the query, a
success/error state, result count, and up to three result titles. Raw JSON and
full result bodies are never shown. This keeps the paper and answer visually
primary while making the agent's evidence-gathering auditable.

The control uses existing theme tokens, a restrained neutral surface, a visible
keyboard focus state, and minimal state-transition motion with a reduced-motion
fallback. It appears in both general chat and paper chat. Existing general-chat
paper cards remain available outside the disclosure only when they are not part
of a tool loop; tool-loop results are represented by the readable summary.

## Data and rendering

A pure frontend helper converts persisted `ChatMessage[]` into render items. It
groups one or more assistant `tool_calls` messages and their following tool
results, including multi-round searches, and leaves user/final-assistant
messages unchanged. Each call is matched to its result by `tool_call_id`.

Arguments and result bodies are parsed defensively. Existing `ui.papers` are the
preferred source for counts and titles; JSON-array tool content is the fallback.
Malformed legacy data produces a generic call row rather than failing chat
rendering. Failed searches are persisted through the same callback as successful
results so they can appear in the activity record immediately.

## Verification

Vitest covers single- and multi-round grouping, readable query/title extraction,
malformed payloads, and failed calls. Frontend typecheck and the full Vitest suite
remain the code gates. Browser verification checks running/open and completed/
folded states, keyboard interaction, both chat layouts, and the absence of the
former blank gap.
