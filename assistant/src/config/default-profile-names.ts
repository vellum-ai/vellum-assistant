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
 * Code-owned profiles that exist only to be named by a call-site default —
 * never offered as a user-selectable model. They resolve through the same
 * intent × provider matrix as the defaults, but are deliberately excluded
 * from the workspace seed and from every profile listing, so the picker
 * still shows exactly Balanced / Speed / Quality.
 *
 * `latency-optimized` is the latency-class profile the live-voice front
 * model runs on: `cost-optimized`'s upstream cannot meet the turn-taking
 * latency envelope, and the alternative — a raw model pin on the call site —
 * resolves to a provider BYOK installs may hold no credential for.
 */
export const INTERNAL_PROFILE_KEYS = ["latency-optimized"] as const;
export type InternalProfileKey = (typeof INTERNAL_PROFILE_KEYS)[number];

/**
 * Every key implemented by the intent × provider matrix: the user-selectable
 * defaults plus the internal call-site-only profiles. This is the set the
 * resolver dereferences against; `DEFAULT_PROFILE_KEYS` alone is the
 * user-facing subset.
 */
export const PROFILE_MATRIX_KEYS = [
  ...DEFAULT_PROFILE_KEYS,
  ...INTERNAL_PROFILE_KEYS,
] as const;
export type ProfileMatrixKey = DefaultProfileKey | InternalProfileKey;

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
 * Lives in this import-free module rather than `default-profile-catalog.ts`
 * so `schemas/llm.ts` can import it without a circular dependency (the
 * catalog imports types from `schemas/llm.ts`).
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
