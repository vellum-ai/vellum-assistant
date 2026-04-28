/**
 * Sync cloud-managed (platform) assistants into the local lockfile.
 *
 * - Adds new platform assistants that aren't in the lockfile yet.
 * - Removes lockfile entries whose IDs are no longer returned by the platform
 *   (e.g. retired assistants).
 *
 * Used by both `vellum login` and `vellum ps` to keep the lockfile fresh.
 */

import {
  loadAllAssistants,
  removeAssistantEntry,
  saveAssistantEntry,
} from "./assistant-config.js";
import {
  fetchPlatformAssistants,
  getPlatformUrl,
  readPlatformToken,
} from "./platform-client.js";

export interface SyncResult {
  added: number;
  removed: number;
}

/**
 * Fetch platform assistants and reconcile against the lockfile.
 * Returns the number of entries added/removed, or `null` if the user
 * is not logged in or the fetch fails.
 */
export async function syncCloudAssistants(): Promise<SyncResult | null> {
  const token = readPlatformToken();
  if (!token) return null;

  let platformAssistants: { id: string; name: string; status: string }[];
  try {
    platformAssistants = await fetchPlatformAssistants(token);
  } catch {
    return null;
  }

  const platformIds = new Set(platformAssistants.map((a) => a.id));

  // Add new platform assistants not yet in the lockfile
  const existingCloudIds = new Set(
    loadAllAssistants()
      .filter((a) => a.cloud === "vellum")
      .map((a) => a.assistantId),
  );

  let added = 0;
  for (const pa of platformAssistants) {
    if (!existingCloudIds.has(pa.id)) {
      saveAssistantEntry({
        assistantId: pa.id,
        runtimeUrl: getPlatformUrl(),
        cloud: "vellum",
        species: "vellum",
        hatchedAt: new Date().toISOString(),
      });
      added++;
    }
  }

  // Remove stale lockfile entries that the platform no longer knows about
  let removed = 0;
  for (const id of existingCloudIds) {
    if (!platformIds.has(id)) {
      removeAssistantEntry(id);
      removed++;
    }
  }

  return { added, removed };
}
