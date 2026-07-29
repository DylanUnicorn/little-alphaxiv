import type { ChatMessage, Conversation } from "../types";

export const MAX_BRANCH_EXCERPT_LENGTH = 2_000;

export interface ConversationHistory {
  id: string;
  root: Conversation;
  representative: Conversation;
  nodes: Conversation[];
  updatedAt: number;
}

export interface ConversationTreeNodeLayout {
  id: string;
  x: number;
  y: number;
  depth: number;
}

export interface ConversationTreeEdgeLayout {
  parentId: string;
  childId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface ConversationTreeLayout {
  width: number;
  height: number;
  nodes: ConversationTreeNodeLayout[];
  edges: ConversationTreeEdgeLayout[];
}

export function normalizeBranchExcerpt(
  text: string,
  maxLength = MAX_BRANCH_EXCERPT_LENGTH,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  if (maxLength <= 1) return "…".slice(0, maxLength);
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function branchMessagesThrough(
  conversation: Conversation,
  messageIndex: number,
): ChatMessage[] {
  const message = conversation.messages[messageIndex];
  if (!message || message.role !== "assistant") {
    throw new Error("A branch must start from an assistant message.");
  }
  return conversation.messages.slice(0, messageIndex + 1);
}

export function isPendingBranchConversation(conversation: Conversation): boolean {
  return !!conversation.parent_id
    && typeof conversation.branch_from_message_index === "number"
    && !!conversation.branch_excerpt
    && conversation.messages.length === conversation.branch_from_message_index + 1;
}

function resolvedHistoryId(conversation: Conversation, knownIds: Set<string>): string {
  const historyId = conversation.history_id;
  return historyId && knownIds.has(historyId) ? historyId : conversation.id;
}

export function groupConversationHistories(
  conversations: Conversation[],
): ConversationHistory[] {
  const knownIds = new Set(conversations.map((conversation) => conversation.id));
  const grouped = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    const historyId = resolvedHistoryId(conversation, knownIds);
    const nodes = grouped.get(historyId) ?? [];
    nodes.push(conversation);
    grouped.set(historyId, nodes);
  }

  const histories: ConversationHistory[] = [];
  for (const [id, unsorted] of grouped) {
    const nodes = [...unsorted].sort(
      (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
    );
    const root = nodes.find((node) => node.id === id)
      ?? nodes.find((node) => !node.parent_id)
      ?? nodes[0];
    const representative = [...nodes].sort(
      (a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at || a.id.localeCompare(b.id),
    )[0];
    histories.push({ id, root, representative, nodes, updatedAt: representative.updated_at });
  }
  return histories.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.root.id.localeCompare(b.root.id),
  );
}

export function collectConversationSubtreeIds(
  conversations: Conversation[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const conversation of conversations) {
    if (!conversation.parent_id) continue;
    const ids = children.get(conversation.parent_id) ?? [];
    ids.push(conversation.id);
    children.set(conversation.parent_id, ids);
  }
  const result: string[] = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return result;
}

export function layoutConversationTree(conversations: Conversation[]): ConversationTreeLayout {
  if (conversations.length === 0) {
    return { width: 128, height: 48, nodes: [], edges: [] };
  }
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const children = new Map<string, Conversation[]>();
  const roots: Conversation[] = [];
  for (const conversation of conversations) {
    if (conversation.parent_id && byId.has(conversation.parent_id)) {
      const list = children.get(conversation.parent_id) ?? [];
      list.push(conversation);
      children.set(conversation.parent_id, list);
    } else {
      roots.push(conversation);
    }
  }
  const stableSort = (nodes: Conversation[]) => nodes.sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  stableSort(roots);
  for (const list of children.values()) stableSort(list);

  const raw = new Map<string, { column: number; depth: number }>();
  let nextLeafColumn = 0;
  let maxDepth = 0;
  const visiting = new Set<string>();
  function place(node: Conversation, depth: number): number {
    if (visiting.has(node.id)) {
      const column = nextLeafColumn++;
      raw.set(node.id, { column, depth });
      return column;
    }
    visiting.add(node.id);
    maxDepth = Math.max(maxDepth, depth);
    const childNodes = children.get(node.id) ?? [];
    const columns = childNodes.map((child) => place(child, depth + 1));
    const column = columns.length > 0
      ? (columns[0] + columns[columns.length - 1]) / 2
      : nextLeafColumn++;
    raw.set(node.id, { column, depth });
    visiting.delete(node.id);
    return column;
  }
  for (const root of roots) place(root, 0);

  const paddingX = 24;
  const paddingY = 24;
  const columnGap = 48;
  const rowGap = 48;
  const contentWidth = paddingX * 2 + Math.max(0, nextLeafColumn - 1) * columnGap;
  const width = Math.max(128, contentWidth);
  const horizontalOffset = (width - contentWidth) / 2;
  const height = Math.max(48, paddingY * 2 + maxDepth * rowGap);
  const nodes = [...raw.entries()]
    .map(([id, value]) => ({
      id,
      x: paddingX + horizontalOffset + value.column * columnGap,
      y: paddingY + value.depth * rowGap,
      depth: value.depth,
    }))
    .sort((a, b) => a.depth - b.depth || a.x - b.x || a.id.localeCompare(b.id));
  const positioned = new Map(nodes.map((node) => [node.id, node]));
  const edges: ConversationTreeEdgeLayout[] = [];
  for (const conversation of conversations) {
    if (!conversation.parent_id) continue;
    const parent = positioned.get(conversation.parent_id);
    const child = positioned.get(conversation.id);
    if (!parent || !child) continue;
    edges.push({
      parentId: parent.id,
      childId: child.id,
      fromX: parent.x,
      fromY: parent.y,
      toX: child.x,
      toY: child.y,
    });
  }
  return { width, height, nodes, edges };
}
