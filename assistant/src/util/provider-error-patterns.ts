// Shared provider-error prose patterns. A neutral leaf module so both the
// provider adapters (which stamp a semantic reason) and the daemon classifier
// (the reason-less fallback) match the same text without importing across
// layers or drifting from hand-synced copies.

// Provider prose that indicates the model can't accept image input.
export const VISION_NOT_SUPPORTED_PATTERNS = [
  /no endpoints found that support image input/i,
  /does not support image/i,
  /doesn't support image input/i,
  /image input is not supported/i,
  /this model does not support vision/i,
  /vision is not supported/i,
  /multi-?modal.*not.*support/i,
];

/**
 * Whether a provider error message indicates the model can't accept image
 * input. Providers wrap raw upstream rejections in their own prose (e.g.
 * `Anthropic API error (400): …`, `Gemini API error (…): …`), so the classifier
 * matches the full {@link VISION_NOT_SUPPORTED_PATTERNS} set rather than any
 * single normalized phrase.
 */
export function isVisionNotSupportedError(message: string): boolean {
  return VISION_NOT_SUPPORTED_PATTERNS.some((re) => re.test(message));
}

// Provider prose from server-side chat-template renderers that failed to
// serialize the request into the model's prompt format. Emitted by
// vLLM/Jinja-style template engines behind OpenAI-compatible endpoints, e.g.
// Together serving MiniMax M3: "Failed to apply chat template: invalid
// operation: object is not callable (in chat:22)".
export const CHAT_TEMPLATE_FAILURE_PATTERNS = [
  /appl\w* (?:the )?chat[ _-]?template/i,
  /chat[ _-]?template (?:error|render)/i,
];

/**
 * Whether a provider error message indicates the endpoint's server-side chat
 * template failed to render the request. These endpoints typically only
 * handle plain-string message content, so structured shapes (content-parts
 * arrays, tool payloads) are what trip the renderer.
 */
export function isChatTemplateFailureError(message: string): boolean {
  return CHAT_TEMPLATE_FAILURE_PATTERNS.some((re) => re.test(message));
}

// Provider prose that indicates the selected model id is unknown to the
// endpoint. Distinct from OpenCode's `ModelError` / "is not supported"
// shape, which is only safe to treat as model-not-found on a 4xx.
export const MODEL_NOT_FOUND_PATTERNS = [
  /model .*(?:not found|does not exist)/i,
  /model_not_found/i,
];

// OpenCode zen returns HTTP 401 with `type=ModelError` and
// "Model <id> is not supported". Treating that as a rejected key sends
// users to update credentials instead of switching models. Do not apply
// these on 5xx: retry treats a stamped reason as authoritative, so a
// transient server error with this type would skip retries and may
// immediately switch profiles.
export const UNSUPPORTED_MODEL_ID_PATTERNS = [
  /model .+ is not supported/i,
  /\bModelError\b/,
];

/**
 * Whether a provider error message indicates the selected model is unknown
 * to the endpoint. Providers wrap raw upstream rejections in their own
 * prose, so the classifier matches the full {@link MODEL_NOT_FOUND_PATTERNS}
 * and {@link UNSUPPORTED_MODEL_ID_PATTERNS} sets rather than any single
 * normalized phrase. Callers that see HTTP 5xx must not use this helper
 * to stamp `model_not_found`.
 */
export function isModelNotFoundError(message: string): boolean {
  return (
    MODEL_NOT_FOUND_PATTERNS.some((re) => re.test(message)) ||
    UNSUPPORTED_MODEL_ID_PATTERNS.some((re) => re.test(message))
  );
}

// Vendor-neutral (OpenRouter/Anthropic-style) credit-exhaustion prose. Also
// covers per-key spend caps: OpenRouter returns 403 "Key limit exceeded" when a
// key's configured credit limit is reached — a billing/budget condition that
// routes to the billing classification alongside other credit exhaustion. The
// phrase is anchored on the contiguous "key limit" so it cannot swallow
// rate-limit prose ("rate limit exceeded") or generic invalid-key text.
export const INSUFFICIENT_CREDITS_PATTERNS = [
  /credit balance is too low/i,
  /insufficient.*credits?/i,
  /key limit (?:has been )?(?:exceeded|reached)/i,
];

// Managed-proxy daily-credit-limit rejection: the platform emits a 402 whose
// body carries `"code": "daily_limit_reached"`. More specific than the generic
// credit-exhaustion prose above — both are 402s from the same proxy — so
// classification sites must test this before INSUFFICIENT_CREDITS_PATTERNS.
export const DAILY_LIMIT_PATTERNS = [/"code"\s*:\s*"daily_limit_reached"/i];
