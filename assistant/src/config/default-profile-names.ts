/**
 * Names of the code-defined default inference profiles.
 *
 * This module is intentionally import-free so any config module (the
 * catalog, the seeder, the flag reconcile) can share the names without
 * import cycles.
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
 * Deliberately NOT part of `DEFAULT_PROFILE_KEYS`: it is never
 * unconditionally available, so it must not be treated as an always-valid
 * reference target.
 */
export const OS_BETA_PROFILE_KEY = "os-beta";
