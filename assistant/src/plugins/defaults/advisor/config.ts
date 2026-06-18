/**
 * Static behavioral configuration for the advisor plugin.
 *
 * The advisor *model* is the inference profile named by `profile`, applied as
 * an `overrideProfile` on the general-purpose `inference` call site — so the
 * consult routes through the workspace's configured provider (managed-proxy or
 * BYOK) with no separate API key.
 */
export const ADVISOR_CONFIG = {
  /**
   * Inference profile the advisor consults. Defaults to the strongest managed
   * profile; the resolver falls back to the active profile if it's absent.
   */
  profile: "quality-optimized",
  // No advisor-specific output cap: the consult omits `max_tokens` (so the
  // resolver applies the profile's normal output budget) and the request text
  // carries no word limit. The advisor decides its own length.
  /** Abort the consult if the sub-call runs longer than this. */
  timeoutMs: 60_000,
  /** Inject the "call advisor before substantive work" steering. */
  steeringEnabled: true,
} as const;
