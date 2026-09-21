/**
 * Provider stop-reason classification.
 *
 * Providers report an output-length cutoff under several normalized
 * finish-reason strings; {@link isMaxTokensStopReason} folds them into a single
 * "was this turn truncated at the token cap?" predicate.
 *
 * Kept dependency-free so it can be re-exported through `@vellumai/plugin-api`
 * without pulling the agent loop (its other caller) into the plugin API's
 * module graph.
 */

/**
 * Normalized provider stop-reason strings that mean the output hit the token
 * cap, as opposed to a natural end-of-turn or a tool-call stop.
 */
const MAX_TOKENS_STOP_REASONS = new Set([
  "length",
  "max_output_tokens",
  "max_tokens",
]);

/**
 * Whether a provider stop reason denotes output truncated at the token cap.
 * Case- and whitespace-insensitive; a `null`/`undefined`/empty reason is false.
 */
export function isMaxTokensStopReason(
  stopReason: string | null | undefined,
): boolean {
  if (!stopReason) {
    return false;
  }
  return MAX_TOKENS_STOP_REASONS.has(stopReason.trim().toLowerCase());
}

/**
 * Provider stop-reason strings that mean the provider's content-safety filter
 * withheld the output: OpenAI `content_filter` (chat-completions
 * `finish_reason` and Responses `incomplete_details.reason`) and Gemini's
 * safety finish reasons. Anthropic's `refusal` is the model declining, not a
 * filter, and is not part of this set.
 */
const CONTENT_FILTER_STOP_REASONS = new Set([
  "content_filter",
  "safety",
  "prohibited_content",
  "blocklist",
]);

/**
 * Whether a provider stop reason denotes output withheld by the provider's
 * content filter. Case- and whitespace-insensitive, like
 * {@link isMaxTokensStopReason}.
 */
export function isContentFilterStopReason(
  stopReason: string | null | undefined,
): boolean {
  if (!stopReason) {
    return false;
  }
  return CONTENT_FILTER_STOP_REASONS.has(stopReason.trim().toLowerCase());
}
