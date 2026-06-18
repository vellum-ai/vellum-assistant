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
  /**
   * Hard cap on advisor output tokens per consult. Mirrors the advisor tool's
   * recommended 2048 (the provider floor is 1024).
   */
  maxTokens: 2048,
  /** Soft word budget requested of the advisor, biasing toward a focused start. */
  wordLimit: 80,
  /** Abort the consult if the sub-call runs longer than this. */
  timeoutMs: 60_000,
  /** Inject the "call advisor before substantive work" steering. */
  steeringEnabled: true,
} as const;
