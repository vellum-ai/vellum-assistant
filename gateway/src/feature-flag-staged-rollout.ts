/**
 * Staged-rollout handling for feature flags whose registry default is on
 * (`defaultEnabled: true`) but whose *managed* rollout is still being gated
 * through LaunchDarkly targeting.
 *
 * Both fail-safes apply **only on managed (platform) deployments** so the
 * managed rollout stays gated on LaunchDarkly targeting. Local / self-hosted
 * installs — even ones that hold platform credentials and sync remote flags —
 * are unaffected: they resolve the `true` registry default.
 *
 *   1. GA-normalization exemption — `RemoteFeatureFlagSync` rewrites a
 *      platform-sent `false` to `true` for GA flags (`defaultEnabled: true`),
 *      because the platform blanket-denies (sends `false` for every flag it
 *      knows). On a managed deployment an exempt flag skips that rewrite so its
 *      explicit `false` is honored; off-platform the rewrite still applies so
 *      the local install gets the `true` default.
 *
 *   2. Managed absent-default — when no explicit value (env/persisted/remote)
 *      is present, the resolvers fall back to the registry default, which is
 *      `true` for these flags. On a managed deployment an absent value can mean
 *      "the platform doesn't know this flag yet" (deployed before the companion
 *      LD provisioning), a stale remote cache from before the flag existed, or
 *      a failed first fetch — none of which should silently opt managed
 *      assistants in. So on managed deployments an exempt flag with no explicit
 *      value resolves to `false` instead of the `true` registry default.
 *
 * Remove a key from {@link GA_NORMALIZATION_EXEMPT_FLAGS} once its managed
 * targeting is complete and it is safe for the platform to leave it on
 * unconditionally.
 *
 * `messages-search-backend`: the registry default is `qdrant`; the managed
 * cutover is gated on the companion LaunchDarkly targeting
 * (`vellum-assistant-platform` #8742) so managed assistants stay on `fts5` until
 * explicitly targeted on.
 */
export const GA_NORMALIZATION_EXEMPT_FLAGS: ReadonlySet<string> = new Set([
  "messages-search-backend",
]);

/** True on a vembda-managed (platform) deployment. */
function isPlatformMode(): boolean {
  const v = process.env.IS_PLATFORM?.trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Whether a platform-sent `false` for `key` should be preserved (skip GA
 * normalization) rather than rewritten to `true`.
 *
 * Only true for a {@link GA_NORMALIZATION_EXEMPT_FLAGS} key on a managed
 * deployment. Off-platform (local/self-hosted, even with platform credentials)
 * this is `false`, so the normal GA normalization applies and the install gets
 * the `true` registry default.
 */
export function shouldExemptFromGaNormalization(key: string): boolean {
  return isPlatformMode() && GA_NORMALIZATION_EXEMPT_FLAGS.has(key);
}

/**
 * Normalize a **remote-layer** (platform-pushed) value for `key` at read time,
 * so a value already persisted in the remote cache is treated the same as a
 * freshly fetched one (`RemoteFeatureFlagSync` applies the identical rule on
 * write via {@link shouldExemptFromGaNormalization}).
 *
 * Off-platform, a stale `false` for a {@link GA_NORMALIZATION_EXEMPT_FLAGS} key
 * — e.g. cached from a pre-flip sync under the platform's blanket-deny — is
 * rewritten to `true` so it does not beat the `true` registry default when the
 * next sync is skipped/failed (missing credentials, `VELLUM_DISABLE_PLATFORM`,
 * network error). On a managed deployment the value passes through unchanged so
 * the platform stays authoritative. Only remote `false` is rewritten; every
 * other value (including any `false` a user persisted locally, which lives in a
 * separate store) is returned as-is.
 */
export function normalizeStaleRemoteFlagValue(
  key: string,
  remoteValue: boolean | string,
): boolean | string {
  if (
    remoteValue === false &&
    GA_NORMALIZATION_EXEMPT_FLAGS.has(key) &&
    !isPlatformMode()
  ) {
    return true;
  }
  return remoteValue;
}

/**
 * Resolve the fallback value for a flag that has no explicit value from any
 * override layer (env / persisted / remote).
 *
 * Returns `false` for a {@link GA_NORMALIZATION_EXEMPT_FLAGS} key on a managed
 * deployment so managed assistants fail safe to the pre-rollout state until LD
 * targeting supplies an explicit value; otherwise returns the registry default.
 */
export function resolveAbsentFlagDefault(
  key: string,
  registryDefault: boolean | string,
): boolean | string {
  if (
    isPlatformMode() &&
    GA_NORMALIZATION_EXEMPT_FLAGS.has(key) &&
    registryDefault === true
  ) {
    return false;
  }
  return registryDefault;
}
