/**
 * Static sanity check for a profile's explicit token budget against the
 * model's catalog limits. Catches configurations that can never dispatch
 * (the output budget consumes the model's entire context window, or exceeds
 * its output cap) at save time instead of on the first chat message.
 *
 * Shared surface: the daemon's profile write routes enforce it as a blocking
 * error, and the web profile editor mirrors the same judgment before its
 * generic config PATCH, so the two paths cannot drift. Only fires when both
 * sides of a judgment are known; unlisted models are covered by the live
 * save-time probe instead.
 */

/**
 * Input room a profile must leave when its output budget is judged against
 * the model's total context window.
 */
export const MIN_INPUT_RESERVE_TOKENS = 4096;

export interface ProfileConfigIssue {
  field: "maxTokens";
  /** Which judgment fired, so clients can compose surface-specific copy. */
  code: "over_output_cap" | "no_input_room";
  message: string;
}

export function validateInferenceProfileConfig(args: {
  maxTokens?: number;
  modelMaxOutputTokens?: number;
  modelContextWindowTokens?: number;
}): ProfileConfigIssue | null {
  const { maxTokens, modelMaxOutputTokens, modelContextWindowTokens } = args;
  if (maxTokens === undefined) {
    return null;
  }
  if (modelMaxOutputTokens !== undefined && maxTokens > modelMaxOutputTokens) {
    return {
      field: "maxTokens",
      code: "over_output_cap",
      message:
        `maxTokens (${maxTokens}) exceeds the model's maximum output of ` +
        `${modelMaxOutputTokens} tokens. Requests would be rejected upstream; ` +
        `reduce maxTokens to ${modelMaxOutputTokens} or less.`,
    };
  }
  if (
    modelContextWindowTokens !== undefined &&
    maxTokens >= modelContextWindowTokens - MIN_INPUT_RESERVE_TOKENS
  ) {
    return {
      field: "maxTokens",
      code: "no_input_room",
      message:
        `maxTokens (${maxTokens}) reserves the entire ${modelContextWindowTokens}-token ` +
        `context window for output, leaving no room for your messages. ` +
        `Reduce maxTokens (e.g. 8000) so input fits.`,
    };
  }
  return null;
}
