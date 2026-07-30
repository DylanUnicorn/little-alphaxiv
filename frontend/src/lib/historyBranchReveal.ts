import type { Conversation } from "../types";

export function newlyAddedBranchIds(
  knownIds: ReadonlySet<string> | null,
  nodes: Conversation[],
): string[] {
  if (!knownIds) return [];
  return nodes
    .filter((node) => !!node.parent_id && !knownIds.has(node.id))
    .map((node) => node.id);
}
