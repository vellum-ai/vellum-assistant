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
  fetchCurrentUser,
  fetchPlatformAssistants,
  getPlatformUrl,
  readPlatformToken,
} from "./platform-client.js";

export type SyncLogger = (message: string) => void;

export interface SyncResult {
  added: number;
  removed: number;
  email?: string;
}

export interface SyncOptions {
  log?: SyncLogger;
}

/**
 * Fetch platform assistants and reconcile against the lockfile.
 * Returns the number of entries added/removed, or `null` if the user
 * is not logged in or the fetch fails.
 */
export async function syncCloudAssistants(
  options?: SyncOptions,
): Promise<SyncResult | null> {
  const log = options?.log;
  const platformUrl = getPlatformUrl();
  log?.(`Platform URL: ${platformUrl}`);

  const token = readPlatformToken();
  if (!token) {
    log?.("No platform token found — skipping cloud sync");
    return null;
  }
  log?.(
    `Token found (${token.length} chars, prefix: ${token.slice(0, 6)}…)`,
  );

  // Fetch user info for the login status line
  let email: string | undefined;
  try {
    log?.("Fetching current user…");
    const user = await fetchCurrentUser(token);
    email = user.email;
    log?.(`Authenticated as ${user.email} (${user.id})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`Failed to fetch current user: ${msg}`);
  }

  let platformAssistants: { id: string; name: string; status: string }[];
  try {
    log?.("Fetching platform assistants…");
    platformAssistants = await fetchPlatformAssistants(token);
    log?.(
      `Platform returned ${platformAssistants.length} assistant(s): ${platformAssistants.map((a) => a.name || a.id).join(", ") || "(none)"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`fetchPlatformAssistants failed: ${msg}`);
    return null;
  }

  if (platformAssistants.length === 0) {
    log?.(
      "Platform returned 0 assistants — this may mean the API returned a non-ok status (check token validity)",
    );
  }

  const platformIds = new Set(platformAssistants.map((a) => a.id));

  // Add new platform assistants not yet in the lockfile
  const existingCloudIds = new Set(
    loadAllAssistants()
      .filter((a) => a.cloud === "vellum")
      .map((a) => a.assistantId),
  );
  log?.(
    `Lockfile has ${existingCloudIds.size} cloud assistant(s): ${[...existingCloudIds].join(", ") || "(none)"}`,
  );

  let added = 0;
  for (const pa of platformAssistants) {
    if (!existingCloudIds.has(pa.id)) {
      log?.(`Adding ${pa.name || pa.id} to lockfile`);
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
      log?.(`Removing stale entry ${id} from lockfile`);
      removeAssistantEntry(id);
      removed++;
    }
  }

  log?.(`Sync complete: ${added} added, ${removed} removed`);
  return { added, removed, email };
}
