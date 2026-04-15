/**
 * Daemon runtime-mode detection.
 *
 * Exposes a single well-named helper `getDaemonRuntimeMode()` that returns
 * `"docker"` when the daemon is running inside a container and
 * `"bare-metal"` otherwise.
 *
 * Under the hood this delegates to `getIsContainerized()` from the env
 * registry, which accepts the standard truthy values for `IS_CONTAINERIZED`
 * (`"true"` or `"1"`). Keeping the check in the registry avoids duplicating
 * the env-parsing semantics across modules.
 *
 * The mode-named API (rather than a boolean) exists to make downstream
 * switch/branch code read naturally — e.g. `if (mode === "docker") { ... }`
 * is clearer than `if (isContainerized) { ... }` when the behavior depends
 * on the specific deployment shape, and it leaves room for additional
 * runtime modes in the future without renaming every callsite.
 */

import { getIsContainerized } from "../config/env-registry.js";

export type DaemonRuntimeMode = "bare-metal" | "docker";

/**
 * Returns the deployment mode the daemon is currently running under.
 *
 * - `"docker"` when `IS_CONTAINERIZED` is set to a truthy value
 *   (`"true"` or `"1"`).
 * - `"bare-metal"` otherwise.
 */
export function getDaemonRuntimeMode(): DaemonRuntimeMode {
  return getIsContainerized() ? "docker" : "bare-metal";
}
