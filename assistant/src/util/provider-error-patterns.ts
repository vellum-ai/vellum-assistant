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
