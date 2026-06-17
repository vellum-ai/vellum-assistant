/**
 * Static behavioral configuration for the advisor plugin.
 *
 * The advisor *model* is NOT configured here. It is selected exactly like any
 * other LLM call site — via the `advisor` entry in the profile config
 * (`config/call-site-defaults.ts`, default profile `quality-optimized`, and the
 * user-overridable `llm.callSites.advisor.profile`). Switching the advisor's
 * model is therefore the same one-step profile selection a user already makes
 * for the base assistant, with no extra setup and no separate API key.
 *
 * These constants only tune the plugin's own behavior around that call.
 */
export const ADVISOR_CONFIG = {
  /**
   * Hard cap on advisor output tokens per consult. Mirrors `max_tokens` on
   * Anthropic's advisor tool definition; the recommended starting point is
   * 2048 (their docs report a ~7x output reduction with near-zero truncation).
   * The provider floor is 1024.
   */
  maxTokens: 2048,
  /**
   * Soft word budget requested of the advisor in the consult prompt, biasing it
   * toward a focused starting point rather than a comprehensive plan.
   */
  wordLimit: 80,
  /** Abort the consult if the advisor sub-call runs longer than this. */
  timeoutMs: 60_000,
  /**
   * Inject the "call advisor before substantive work" steering into the
   * executor's system prompt so the model actually reaches for the tool.
   */
  steeringEnabled: true,
} as const;
