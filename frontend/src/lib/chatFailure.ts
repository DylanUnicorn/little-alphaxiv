import type { ChatMessage } from "../types";

const CONNECTION_ERROR_PATTERN =
  /Connect(?:Error|Timeout)|Read(?:Error|Timeout)|WriteError|RemoteProtocolError|NetworkError|Failed to fetch|fetch failed|network request failed|connection (?:reset|refused|failed)/i;

/** Translate connection-layer implementation details into an actionable message.
 * Raw exception names remain available in backend logs for diagnosis. */
export function userFacingStreamError(
  rawMessage: string,
  hasPartialOutput: boolean,
): string {
  if (!CONNECTION_ERROR_PATTERN.test(rawMessage)) return rawMessage;
  if (hasPartialOutput) {
    return "The connection to the model service was interrupted. Your partial response was kept; check Docker or the upstream provider, then try again.";
  }
  return "Couldn't connect to the model service after retrying. Check Docker or the upstream provider, then try again.";
}

/** Build one persisted assistant message for a failed stream.
 *
 * Before output starts, the warning is the content and must not be repeated in
 * ui.error. After output starts, preserve the partial answer and attach a small
 * interruption detail below it.
 */
export function buildStreamFailureMessage(
  buffer: string,
  errorMessage: string,
): ChatMessage {
  if (buffer.trim()) {
    return {
      role: "assistant",
      content: buffer,
      ui: { error: `Response interrupted: ${errorMessage}` },
    };
  }
  return { role: "assistant", content: `⚠️ ${errorMessage}` };
}
