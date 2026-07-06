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
 */
export const OS_BETA_PROFILE_KEY = "os-beta";

/**
 * Every default profile name the code catalog can serve, including the
 * flag-gated one. Used by `LLMSchema.superRefine` to accept references to
 * default profiles regardless of whether they are materialized in
 * `llm.profiles` (the resolver serves them from the code catalog).
 */
export const CATALOG_DEFAULT_PROFILE_NAMES: ReadonlySet<string> = new Set([
  ...DEFAULT_PROFILE_KEYS,
  OS_BETA_PROFILE_KEY,
]);
