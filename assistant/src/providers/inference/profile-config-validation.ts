/**
 * Static sanity check for a profile's explicit token budget against the
 * model's catalog limits. Catches configurations that can never dispatch
 * (the output budget consumes the model's entire context window, or exceeds
 * its output cap) at save time instead of on the first chat message.
 *
 * Only judges what is knowable offline: fires when the profile explicitly
 * sets `maxTokens` AND the catalog declares a limit for the model. Unlisted
 * models are covered by the live save-time probe instead
 * (`profile-probe.ts`). Note `clampMaxTokensToModelCap` in
 * `default-profile-catalog.ts` protects only code-owned default profiles;
 * user-authored profiles send their `maxTokens` verbatim.
 */

/**
 * Input room a profile must leave when its output budget is judged against
 * the model's total context window.
 */
export const MIN_INPUT_RESERVE_TOKENS = 4096;

export interface ProfileConfigIssue {
  field: "maxTokens";
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
      message:
        `maxTokens (${maxTokens}) reserves the entire ${modelContextWindowTokens}-token ` +
        `context window for output, leaving no room for your messages. ` +
        `Reduce maxTokens (e.g. 8000) so input fits.`,
    };
  }
  return null;
}
