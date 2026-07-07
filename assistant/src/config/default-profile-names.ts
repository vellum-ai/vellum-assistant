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

/**
 * Providers that can serve the default profiles. `vellum` is the
 * platform-managed column (routed through the single `vellum` connection to
 * an underlying provider per profile); the rest are BYOK columns whose
 * models resolve per provider via `resolveModelIntent`.
 *
 * Lives in this import-free module (rather than `default-profile-catalog.ts`,
 * which re-exports it) so `schemas/llm.ts` can validate `llm.defaultProvider`
 * against it without a circular import — the catalog already imports types
 * from `schemas/llm.ts`.
 */
export const DEFAULT_PROFILE_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "fireworks",
  "openrouter",
  "vellum",
] as const;
export type DefaultProfileProvider = (typeof DEFAULT_PROFILE_PROVIDERS)[number];
