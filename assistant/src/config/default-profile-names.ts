/**
 * Names of the code-defined default inference profiles.
 *
 * This module is intentionally import-free so any config module (the
 * catalog, the seeder, the flag reconcile) can share the names without
 * import cycles.
 */

/**
 * Stable keys of the always-available default profiles, in picker order.
 *
 * A key is an on-disk contract: `llm.callSites.*.profile`, `activeProfile`,
 * mix arms and schedule pins all reference it, so a key is fixed regardless of
 * the label its profile carries. `cost-optimized` is labelled "Cost" and
 * `latency-optimized` is labelled "Speed" (see `default-profile-catalog.ts`).
 *
 * `latency-optimized` also backs the live-voice front model, which is why it
 * exists as a profile rather than a raw model pin on the call site: a pin
 * resolves to a provider BYOK installs may hold no credential for.
 */
export const DEFAULT_PROFILE_KEYS = [
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "latency-optimized",
] as const;
export type DefaultProfileKey = (typeof DEFAULT_PROFILE_KEYS)[number];

/**
 * Stable keys of the managed backup profiles, one per default profile.
 * Deliberately NOT part of `DEFAULT_PROFILE_KEYS`: that array drives picker
 * order and the intent x provider matrix, while backups are companions of
 * the managed (`vellum`) column only. Each backup pins a model at a
 * different upstream provider than its primary, so an outage at the
 * primary's provider can be served by re-sending on the backup (see the
 * `fallbackProfile` field on `ProfileEntry`).
 */
export const BACKUP_PROFILE_KEYS = [
  "balanced-backup",
  "quality-optimized-backup",
  "cost-optimized-backup",
  "latency-optimized-backup",
] as const;
export type BackupProfileKey = (typeof BACKUP_PROFILE_KEYS)[number];

/**
 * The backup profile each default profile falls back to. Applied to the
 * managed (`vellum`) column implementations only: BYOK installs may hold no
 * credential for the backup's provider, so their columns carry no
 * `fallbackProfile` pointers.
 */
export const FALLBACK_PROFILE_BY_KEY: Record<
  DefaultProfileKey,
  BackupProfileKey
> = {
  balanced: "balanced-backup",
  "quality-optimized": "quality-optimized-backup",
  "cost-optimized": "cost-optimized-backup",
  "latency-optimized": "latency-optimized-backup",
};

export function isDefaultProfileKey(value: string): value is DefaultProfileKey {
  return (DEFAULT_PROFILE_KEYS as readonly string[]).includes(value);
}

export function isBackupProfileKey(value: string): value is BackupProfileKey {
  return (BACKUP_PROFILE_KEYS as readonly string[]).includes(value);
}

/**
 * Flag-gated default profile: only available while the `os-beta` feature
 * flag has reconciled it into the workspace (see `sync-gated-profiles.ts`).
 * Deliberately NOT part of `DEFAULT_PROFILE_KEYS`: it is never
 * unconditionally available, so it must not be treated as an always-valid
 * reference target.
 */
export const OS_BETA_PROFILE_KEY = "os-beta";

/**
 * The named columns of the intent × provider matrix. `vellum` is the
 * platform-managed column (routed through the single `vellum` connection to
 * an underlying provider per profile) and `chatgpt` is the
 * ChatGPT-subscription column (routed through the `chatgpt-subscription`
 * connection to the Codex endpoint); the rest are BYOK columns whose
 * models resolve per provider via `resolveModelIntent`. The full set of
 * providers that can back `llm.defaultProvider` is wider, see
 * `DEFAULT_PROVIDER_CHOICES` in `schemas/llm.ts`.
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
  "chatgpt",
  "vellum",
] as const;
export type DefaultProfileProvider = (typeof DEFAULT_PROFILE_PROVIDERS)[number];

/**
 * Whether a provider has its own named column in the matrix. Providers
 * outside this set can still back the default profiles: they materialize
 * from the shared BYOK templates with the intent falling back to the
 * provider's catalog `defaultModel` (see `defaultProfileBodyForProvider`).
 */
export function isDefaultProfileProvider(
  value: string,
): value is DefaultProfileProvider {
  return (DEFAULT_PROFILE_PROVIDERS as readonly string[]).includes(value);
}
