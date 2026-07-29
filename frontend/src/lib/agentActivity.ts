import type { ChatMessage, Paper, ToolCall } from "../types";

export type AgentActivityStatus = "pending" | "success" | "error";

export interface AgentActivityStep {
  id: string;
  toolName: string;
  label: string;
  query?: string;
  status: AgentActivityStatus;
  resultCount?: number;
  resultTitles: string[];
  errorMessage?: string;
}

export interface MessageRenderItem {
  kind: "message";
  key: string;
  index: number;
  message: ChatMessage;
}

export interface ActivityRenderItem {
  kind: "activity";
  key: string;
  startIndex: number;
  endIndex: number;
  steps: AgentActivityStep[];
  totalResults: number;
}

export type ChatRenderItem = MessageRenderItem | ActivityRenderItem;

const TOOL_LABELS: Record<string, string> = {
  search_arxiv: "arXiv search",
  web_search: "Web search",
  search_openalex: "OpenAlex search",
  search_semantic_scholar: "Semantic Scholar search",
};

function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Tool call";
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function callQuery(call: ToolCall): string | undefined {
  const args = parseObject(call.function.arguments || "{}");
  if (!args) return undefined;
  const value = args.query ?? args.q ?? args.url;
  if (typeof value !== "string") return undefined;
  const query = value.trim();
  return query || undefined;
}

function parseResultArray(content: string | null): unknown[] | null {
  if (!content) return null;
  const candidates = [content];
  const arrayStart = content.indexOf("[");
  if (arrayStart > 0) candidates.push(content.slice(arrayStart));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Some web-search providers prefix a human status line before JSON.
    }
  }
  return null;
}

function resultSummary(message: ChatMessage): { count?: number; titles: string[] } {
  const papers: Paper[] | undefined = message.ui?.papers;
  if (papers) {
    return {
      count: papers.length,
      titles: papers.map((paper) => paper.title.trim()).filter(Boolean).slice(0, 3),
    };
  }

  const results = parseResultArray(message.content);
  if (!results) return { titles: [] };
  const titles = results
    .map((result) => {
      if (!result || typeof result !== "object" || Array.isArray(result)) return "";
      const title = (result as Record<string, unknown>).title;
      return typeof title === "string" ? title.trim() : "";
    })
    .filter(Boolean)
    .slice(0, 3);
  return { count: results.length, titles };
}

function isFailure(content: string | null): boolean {
  return !!content && /\b(?:failed|error|unknown tool)\b/i.test(content);
}

function readableError(content: string | null): string {
  if (!content) return "Tool failed";
  const parenthesized = content.match(/failed\s*\(([^)]+)\)/i)?.[1]?.trim();
  if (parenthesized) return `Search failed: ${parenthesized.slice(0, 120)}`;
  if (/unknown tool/i.test(content)) return "Tool unavailable";
  return "Search failed";
}

function activitySteps(protocolMessages: ChatMessage[]): AgentActivityStep[] {
  const resultByCall = new Map<string, ChatMessage>();
  for (const message of protocolMessages) {
    if (message.role === "tool" && message.tool_call_id) {
      resultByCall.set(message.tool_call_id, message);
    }
  }

  const steps: AgentActivityStep[] = [];
  for (const message of protocolMessages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      const result = resultByCall.get(call.id);
      const failed = result ? isFailure(result.content) : false;
      const summary = result && !failed ? resultSummary(result) : { titles: [] };
      steps.push({
        id: call.id,
        toolName: call.function.name,
        label: toolLabel(call.function.name),
        query: callQuery(call),
        status: !result ? "pending" : failed ? "error" : "success",
        resultCount: summary.count,
        resultTitles: summary.titles,
        ...(failed ? { errorMessage: readableError(result?.content ?? null) } : {}),
      });
    }
  }
  return steps;
}

function isToolCallMessage(message: ChatMessage | undefined): boolean {
  return message?.role === "assistant" && !!message.tool_calls?.length;
}

function isInvisibleEmptyAssistant(message: ChatMessage): boolean {
  return message.role === "assistant"
    && !message.tool_calls?.length
    && !(message.content?.trim())
    && !message.ui?.error
    && !message.ui?.stopped;
}

/**
 * Convert persisted OpenAI assistant/tool protocol messages into a render model.
 * Stored history stays byte-for-byte intact for model context and auditing.
 */
export function buildChatRenderItems(messages: ChatMessage[]): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (isToolCallMessage(message)) {
      const startIndex = index;
      const protocolMessages: ChatMessage[] = [];

      while (index < messages.length && isToolCallMessage(messages[index])) {
        protocolMessages.push(messages[index]);
        index += 1;
        while (index < messages.length && messages[index].role === "tool") {
          protocolMessages.push(messages[index]);
          index += 1;
        }
      }

      const steps = activitySteps(protocolMessages);
      items.push({
        kind: "activity",
        key: `activity-${startIndex}`,
        startIndex,
        endIndex: index - 1,
        steps,
        totalResults: steps.reduce((sum, step) => sum + (step.resultCount ?? 0), 0),
      });
      continue;
    }

    if (!isInvisibleEmptyAssistant(message)) {
      items.push({ kind: "message", key: `message-${index}`, index, message });
    }
    index += 1;
  }

  return items;
}
