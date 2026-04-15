/**
 * Maps lockfile topology into an explicit auth profile enum used by the
 * chrome extension to decide which auth flow to use for a given assistant.
 *
 * The lockfile's `cloud` field describes the hosting topology:
 *   - `"local"` — a locally running assistant (bare-metal or dev mode).
 *   - `"apple-container"` — a locally running assistant inside an Apple
 *     Virtualization.framework container.
 *   - `"vellum"` — a Vellum-cloud-managed assistant.
 *   - `"platform"` — legacy alias for `"vellum"` (older lockfiles).
 *
 * The auth profile simplifies downstream decision-making: rather than
 * checking `cloud` values and `runtimeUrl` presence in multiple places,
 * callers resolve the profile once and branch on the three-case enum.
 */

/**
 * Auth profile enum that the extension uses to decide which auth flow
 * to invoke for a given assistant.
 *
 * - `local-pair` — pair via the native messaging helper
 *   (`chrome.runtime.connectNative`). Used for locally running assistants
 *   where the extension can reach the assistant over loopback.
 * - `cloud-oauth` — sign in via `chrome.identity.launchWebAuthFlow`
 *   against the Vellum cloud gateway. Used for cloud-managed assistants.
 * - `unsupported` — the lockfile topology is not recognised by this
 *   version of the extension. The caller should surface a user-facing
 *   message suggesting an extension update.
 */
export type AssistantAuthProfile = 'local-pair' | 'cloud-oauth' | 'unsupported';

/**
 * The subset of lockfile topology fields needed to derive the auth profile.
 * Matches the shape of `AssistantEntry` from `cli/src/lib/assistant-config.ts`
 * without introducing a hard import dependency on the CLI package.
 */
export interface LockfileTopology {
  /** Hosting topology value, e.g. `"local"`, `"apple-container"`, `"vellum"`, `"platform"`. */
  cloud: string;
  /** Gateway runtime URL. Present for cloud-managed assistants. */
  runtimeUrl?: string;
}

/** Cloud values that map to local native-messaging pairing. */
const LOCAL_CLOUD_VALUES = new Set(['local', 'apple-container']);

/** Cloud values that map to cloud OAuth sign-in. */
const CLOUD_CLOUD_VALUES = new Set(['vellum', 'platform']);

/**
 * Derive the auth profile for a given assistant's lockfile topology.
 *
 * The mapping is intentionally strict — only known `cloud` values produce
 * a usable profile. Unknown values yield `unsupported` so a stale
 * extension doesn't silently try the wrong auth flow against a new
 * topology introduced in a future release.
 */
export function resolveAuthProfile(topology: LockfileTopology): AssistantAuthProfile {
  if (LOCAL_CLOUD_VALUES.has(topology.cloud)) {
    return 'local-pair';
  }
  if (CLOUD_CLOUD_VALUES.has(topology.cloud)) {
    return 'cloud-oauth';
  }
  return 'unsupported';
}
