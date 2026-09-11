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

/**
 * Decide whether unsigned function-call history should receive Google's
 * documented dummy thought signature. Returns the first call's index when
 * every call is unsigned. Pass `model` to restrict this to Gemini 3.x;
 * omit it for retry backfills that already observed a thought-signature 4xx.
 */
export function unsignedThoughtSignatureFallback(
  signatures: ReadonlyArray<string | undefined | null>,
  options?: { model?: string },
): { index: 0; signature: string } | undefined {
  if (options?.model !== undefined && !isGemini3Model(options.model)) {
    return undefined;
  }
  if (signatures.length === 0) {
    return undefined;
  }
  if (signatures.some((signature) => Boolean(signature))) {
    return undefined;
  }
  return {
    index: 0,
    signature: GEMINI_3_UNSIGNED_TOOL_CALL_THOUGHT_SIGNATURE,
  };
}
