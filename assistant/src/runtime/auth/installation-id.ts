/**
 * Installation ID resolver.
 *
 * Reads the installation ID from the lockfile for use in telemetry and
 * other contexts that need a globally unique identifier for this
 * assistant installation. The installation ID is a UUID generated at
 * hatch time and persisted in the lockfile.
 *
 * The value is cached in memory after the first successful read.
 * Falls back to 'unknown' if the lockfile is unreadable or has no
 * installationId in any assistant entry.
 */

import { getLogger } from "../../util/logger.js";
import { readLockfile } from "../../util/platform.js";

const log = getLogger("installation-id");

let cached: string | undefined;

/**
 * Get the installation ID from the lockfile.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. Most recently hatched entry in lockfile assistants array
 *      (sorted by `hatchedAt` descending) -> installationId
 *   3. Fallback: 'unknown'
 */
export function getInstallationId(): string {
  if (cached !== undefined) {
    return cached;
  }

  try {
    const lockData = readLockfile();
    if (lockData) {
      const assistants = lockData.assistants as
        | Array<Record<string, unknown>>
        | undefined;
      if (assistants && assistants.length > 0) {
        // Sort by hatchedAt descending to use the most recent entry,
        // matching the pattern used elsewhere in the codebase.
        const sorted = [...assistants].sort((a, b) => {
          const dateA = new Date((a.hatchedAt as string) || 0).getTime();
          const dateB = new Date((b.hatchedAt as string) || 0).getTime();
          return dateB - dateA;
        });
        const latest = sorted[0];
        if (typeof latest.installationId === "string") {
          cached = latest.installationId;
          log.info(
            { installationId: cached },
            "Resolved installation ID from lockfile",
          );
          return cached;
        }
      }
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to read lockfile for installation ID — falling back to unknown",
    );
  }

  log.warn("No installationId found in lockfile — falling back to unknown");
  cached = "unknown";
  return cached;
}

/**
 * Reset the cached installation ID. Used by tests to force
 * re-resolution on the next call.
 */
export function resetInstallationIdCache(): void {
  cached = undefined;
}
