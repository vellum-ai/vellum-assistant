/**
 * External assistant ID resolver.
 *
 * Reads the external assistant ID from the lockfile for use in
 * edge-facing JWT tokens (aud=vellum-gateway). The external ID is
 * needed because the gateway must identify which assistant the token
 * belongs to, while the daemon internally uses 'self'.
 *
 * The value is cached in memory after the first successful read.
 * Falls back to 'self' if the lockfile is unreadable or has no
 * assistant entries.
 */

import { readLockfile } from '../../util/platform.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('external-assistant-id');

let cached: string | null = null;

/**
 * Get the external assistant ID from the lockfile.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. Most recently hatched entry in lockfile assistants array
 *      (sorted by `hatchedAt` descending) → assistantId
 *   3. Fallback: 'self'
 */
export function getExternalAssistantId(): string {
  if (cached !== null) {
    return cached;
  }

  try {
    const lockData = readLockfile();
    if (lockData) {
      const assistants = lockData.assistants as Array<Record<string, unknown>> | undefined;
      if (assistants && assistants.length > 0) {
        // Sort by hatchedAt descending to use the most recent entry,
        // matching the pattern used elsewhere in the codebase.
        const sorted = [...assistants].sort((a, b) => {
          const dateA = new Date((a.hatchedAt as string) || 0).getTime();
          const dateB = new Date((b.hatchedAt as string) || 0).getTime();
          return dateB - dateA;
        });
        const latest = sorted[0];
        if (typeof latest.assistantId === 'string') {
          cached = latest.assistantId;
          log.info({ externalAssistantId: cached }, 'Resolved external assistant ID from lockfile');
          return cached;
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to read lockfile for external assistant ID — falling back to self');
  }

  cached = 'self';
  return cached;
}

/**
 * Reset the cached external assistant ID. Used by tests to force
 * re-resolution on the next call.
 */
export function resetExternalAssistantIdCache(): void {
  cached = null;
}
