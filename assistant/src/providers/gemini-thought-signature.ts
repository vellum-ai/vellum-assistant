/**
 * Gemini 3.x requires a thought signature on the first function-call part of
 * each step. When history has no captured signature (unsigned tool_use from an
 * earlier provider, or a client-injected call), Google documents these dummy
 * values to skip validation.
 */
export const GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE =
  "context_engineering_is_the_way_to_go";

/**
 * True for Gemini 3.x model ids, including the native `models/` prefix and
 * OpenAI-compatible catalog prefixes such as `google/gemini-3.7-flash`.
 */
export function isGemini3Model(model: string): boolean {
  if (model.startsWith("gemini-3") || model.startsWith("models/gemini-3")) {
    return true;
  }
  return /\/gemini-3/.test(model);
}
