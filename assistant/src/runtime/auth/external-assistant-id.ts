/**
 * External assistant ID resolver.
 *
 * Resolves the external assistant ID for use in edge-facing JWT tokens
 * (aud=vellum-gateway). The external ID is needed because the gateway
 * must identify which assistant the token belongs to, while the daemon
 * internally uses 'self'.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. Most recently hatched entry in lockfile assistants array
 *      (sorted by `hatchedAt` descending) → assistantId
 *   3. BASE_DATA_DIR path matching `/assistants/<name>` suffix
 *   4. `undefined` — callers must handle the missing value
 *
 * The value is cached in memory after the first successful read.
 */

import { getBaseDataDir } from "../../config/env-registry.js";
import { getLogger } from "../../util/logger.js";
import { readLockfile } from "../../util/platform.js";

const log = getLogger("external-assistant-id");

let cached: string | null | undefined;

/**
 * Get the external assistant ID.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. Most recently hatched entry in lockfile assistants array
 *      (sorted by `hatchedAt` descending) → assistantId
 *   3. BASE_DATA_DIR path matching `/assistants/<name>` suffix
 *   4. `undefined` when resolution fails entirely
 */
export function getExternalAssistantId(): string | undefined {
  if (cached !== undefined) {
    return cached ?? undefined;
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
        if (typeof latest.assistantId === "string") {
          cached = latest.assistantId;
          log.info(
            { externalAssistantId: cached },
            "Resolved external assistant ID from lockfile",
          );
          return cached;
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to read lockfile for external assistant ID");
  }

  // Fallback: derive from BASE_DATA_DIR path
  const base = getBaseDataDir();
  if (base && typeof base === "string") {
    const normalized = base.replace(/\\/g, "/").replace(/\/+$/, "");
    const match = normalized.match(/\/assistants\/([^/]+)$/);
    if (match) {
      cached = match[1];
      log.info(
        { externalAssistantId: cached },
        "Resolved external assistant ID from BASE_DATA_DIR",
      );
      return cached;
    }
  }

  cached = null;
  return undefined;
}

/**
 * Reset the cached external assistant ID. Used by tests to force
 * re-resolution on the next call.
 */
export function resetExternalAssistantIdCache(): void {
  cached = undefined;
}
