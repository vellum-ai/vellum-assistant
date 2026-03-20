import { getSummaryFromContextMessage } from "../context/window-manager.js";
import type { Message } from "../providers/types.js";

const TRUNCATION_MARKER = "<truncated />";

export interface MemoryQueryBuilderOptions {
  maxUserRequestChars?: number;
  maxSessionSummaryChars?: number;
}

/**
 * Build a deterministic memory recall query string from the current user
 * request plus any in-context session summary message.
 */
export function buildMemoryQuery(
  userRequest: string,
  messages: Message[],
  options?: MemoryQueryBuilderOptions,
): string {
  const maxUserRequestChars = options?.maxUserRequestChars ?? 2000;
  const maxSessionSummaryChars = options?.maxSessionSummaryChars ?? 1200;

  const requestText = clampSection(userRequest.trim(), maxUserRequestChars);
  const sessionSummary = messages
    .map((message) => getSummaryFromContextMessage(message))
    .find((summary): summary is string => summary != null);

  const content = requestText.length > 0 ? requestText : "(empty)";

  if (sessionSummary && sessionSummary.trim().length > 0) {
    const compactSummary = clampSection(
      sessionSummary.trim(),
      maxSessionSummaryChars,
    );
    return `${content}\n\nContext summary:\n${compactSummary}`;
  }

  return content;
}

function clampSection(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const half = Math.floor((maxChars - TRUNCATION_MARKER.length) / 2);
  if (half <= 0) return value.slice(0, maxChars);
  return value.slice(0, half) + TRUNCATION_MARKER + value.slice(-half);
}
