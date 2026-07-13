export const MAX_SELECTED_TEXT_LENGTH = 2_000;

export function normalizeSelectedText(text: string, maxLength = MAX_SELECTED_TEXT_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export function findSelectedPdfPage(node: Element): number | null {
  const page = node.closest<HTMLElement>(".pdf-page-wrap[data-page-number]");
  const value = Number(page?.dataset.pageNumber);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export interface SelectedPdfTextPayload {
  text: string;
  pageNumber: number;
}

export interface PendingSelectedTextContext {
  conversationId: string;
  context: SelectedPdfTextPayload;
}

export function selectedPdfTextPayload(
  text: string,
  startPage: number | null,
  endPage: number | null,
): SelectedPdfTextPayload | null {
  const normalized = normalizeSelectedText(text);
  if (!normalized || !startPage || startPage !== endPage) return null;
  return { text: normalized, pageNumber: startPage };
}

export function buildSelectedTextMessage(
  context: SelectedPdfTextPayload,
  userPrompt: string,
): string {
  const quoted = context.text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const prompt = userPrompt.trim() || "Please explain this excerpt.";
  return `Excerpt from page ${context.pageNumber}:\n\n${quoted}\n\n${prompt}`;
}

export function pendingContextForConversation(
  pending: PendingSelectedTextContext | null,
  conversationId: string | null,
): SelectedPdfTextPayload | null {
  return pending?.conversationId === conversationId ? pending.context : null;
}

export function clearPendingContextAfterSend(
  pending: PendingSelectedTextContext | null,
  conversationId: string,
  sentContext: SelectedPdfTextPayload,
): PendingSelectedTextContext | null {
  if (pending?.conversationId !== conversationId || pending.context !== sentContext) {
    return pending;
  }
  return null;
}

export function visibleSelectedTextPayload<T>(payload: T | null, disabled: boolean): T | null {
  return disabled ? null : payload;
}
