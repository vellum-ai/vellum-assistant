/**
 * Names of the code-defined default inference profiles.
 *
 * This module is intentionally import-free: `schemas/llm.ts` needs the names
 * for reference validation while `default-profile-catalog.ts` (which imports
 * runtime values from `schemas/llm.ts`) needs them to key the catalog, so the
 * names live in a leaf module both can import without a cycle.
 */

/** Stable keys of the always-available default profiles. */
export const DEFAULT_PROFILE_KEYS = [
  "balanced",
  "quality-optimized",
  "cost-optimized",
] as const;
export type DefaultProfileKey = (typeof DEFAULT_PROFILE_KEYS)[number];

/**
 * Flag-gated default profile: only available while the `os-beta` feature
 * flag has reconciled it into the workspace (see `sync-gated-profiles.ts`).
 * Deliberately NOT part of `DEFAULT_PROFILE_KEYS`: references to it are only
 * valid while a workspace entry exists, so schema validation must not treat
 * it as always resolvable.
 */
export const OS_BETA_PROFILE_KEY = "os-beta";
