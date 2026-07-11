export const MAX_SELECTED_TEXT_LENGTH = 2_000;

export function normalizeSelectedText(text: string, maxLength = MAX_SELECTED_TEXT_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export function buildSelectedTextPrompt(text: string, pageNumber: number): string {
  return `Please explain this excerpt from page ${pageNumber} of the paper:\n\n> ${text}`;
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

export interface PendingSelectedTextPrompt {
  conversationId: string;
  prompt: string;
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

export function consumePendingPrompt(prompt: string | null | undefined, busy: boolean) {
  const text = prompt?.trim();
  if (busy || !text) return { prompt: null, consumed: false };
  return { prompt: text, consumed: true };
}

export function pendingPromptForConversation(
  pending: PendingSelectedTextPrompt | null,
  conversationId: string | null,
): string | null {
  return pending?.conversationId === conversationId ? pending.prompt : null;
}

export function visibleSelectedTextPayload<T>(payload: T | null, disabled: boolean): T | null {
  return disabled ? null : payload;
}
