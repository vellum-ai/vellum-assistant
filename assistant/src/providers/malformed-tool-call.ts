/**
 * Upstream finish reasons that mean the model tried to call a tool but the
 * call did not parse.
 *
 * Gemini reports these as `MALFORMED_FUNCTION_CALL` (the call was not valid)
 * and `UNEXPECTED_TOOL_CALL` (a call the request did not allow). The native
 * Gemini API returns them as `candidate.finishReason`; OpenRouter normalizes
 * them away in `finish_reason` and passes the raw value through in
 * `native_finish_reason`. Such responses often carry the tail of the broken
 * call as plain assistant text, so they must never be taken as a final answer.
 * Providers throw a status-less `ProviderError` carrying
 * {@link MALFORMED_TOOL_CALL_MESSAGE}, which the retry layer (`retry.ts`)
 * resends once with a corrective note.
 */

import { ProviderError } from "../util/errors.js";

/** Message fragment shared by the provider throw sites and the retry classifier. */
export const MALFORMED_TOOL_CALL_MESSAGE =
  "Model emitted a malformed tool call";

const MALFORMED_TOOL_CALL_FINISH_REASONS = new Set([
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
]);

/**
 * Whether an upstream finish reason denotes a malformed tool call.
 * Case- and whitespace-insensitive; a `null`/`undefined`/empty reason is false.
 */
export function isMalformedToolCallFinishReason(
  finishReason: string | null | undefined,
): boolean {
  if (!finishReason) {
    return false;
  }
  return MALFORMED_TOOL_CALL_FINISH_REASONS.has(
    finishReason.trim().toUpperCase(),
  );
}

/**
 * Status-less provider error for a response that ended on a malformed tool
 * call. The absent status marks it as a stream-content failure, which the
 * retry layer classifies by message.
 */
export function malformedToolCallError(
  provider: string,
  finishReason: string,
): ProviderError {
  return new ProviderError(
    `${MALFORMED_TOOL_CALL_MESSAGE} (finish reason: ${finishReason})`,
    provider,
  );
}
