/**
 * Workspace-relative filename the usage export is staged at before the
 * conversation. Shared by `setup.ts` (which stages it) and the SPEC's
 * file-clarification hint (which points the agent at it).
 */
export const USAGE_WORKSPACE_FILENAME = "product-usage.csv";

/**
 * Expected answer for the usage fixture. `assets/product-usage.csv` must keep
 * "claude-sonnet-4-6" as the unambiguous highest-total-token model (input +
 * output summed across the whole export), or this constant must change with it.
 */
export const HIGHEST_TOKEN_MODEL = "claude-sonnet-4-6";

/**
 * Every model present in the fixture, by the canonical token the assistant is
 * likely to echo. The judge maps a longer or reformatted name (e.g. "Claude
 * Sonnet 4.6") onto one of these before scoring.
 */
export const USAGE_MODELS = [
  "claude-sonnet-4-6",
  "gpt-4o",
  "gemini-2.5-pro",
  "claude-haiku-4-5",
  "gpt-4o-mini",
];
