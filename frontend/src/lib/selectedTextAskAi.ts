export const MAX_SELECTED_TEXT_LENGTH = 2_000;

export function normalizeSelectedText(text: string, maxLength = MAX_SELECTED_TEXT_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

export function buildSelectedTextPrompt(text: string, pageNumber: number): string {
  return `Please explain this excerpt from page ${pageNumber} of the paper:\n\n> ${text}`;
}
