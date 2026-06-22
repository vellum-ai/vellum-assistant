/**
 * Static behavioral configuration for the advisor.
 *
 * The advisor *model* is no longer hardcoded here: it routes through the
 * dedicated `advisor` call site, whose default profile (`quality-optimized`)
 * lives in CALL_SITE_DEFAULTS and is overridden per workspace by
 * `llm.advisorProfile`. Whether the advisor is active is decided per chat
 * profile by `ProfileEntry.advisorEnabled` (default on).
 */
export const ADVISOR_CONFIG = {
  // No advisor-specific output cap: the consult omits `max_tokens` (so the
  // resolver applies the profile's normal output budget) and the request text
  // carries no word limit. The advisor decides its own length.
  /** Abort the consult if the sub-call runs longer than this. */
  timeoutMs: 60_000,
  /**
   * Global kill-switch for the steering injection. The per-chat-profile
   * `advisorEnabled` toggle gates it further; this stays as a hard off switch.
   */
  steeringEnabled: true,
} as const;
