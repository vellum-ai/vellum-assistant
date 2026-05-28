/**
 * Sync cloud-managed (platform) assistants into the local lockfile.
 *
 * - Adds new platform assistants that aren't in the lockfile yet.
 * - Removes lockfile entries whose IDs are no longer returned by the platform
 *   (e.g. retired assistants).
 *
 * Used by both `vellum login` and `vellum ps` to keep the lockfile fresh.
 *
 * **Contract:** callers must verify the user is logged in (i.e. a non-empty
 * platform token exists) before invoking this helper. The "is there a token?"
 * decision belongs at the command level so commands can render the right
 * "Platform: …" status without ever entering the platform fetch path.
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
} from "./platform-client.js";

export type SyncLogger = (message: string) => void;

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.includes("timed out"))
  );
}

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
 *
 * Returns the number of entries added/removed, or `null` if the fetch fails
 * (e.g. platform unreachable, invalid token). Callers must pre-verify a
 * non-empty token; this function assumes one is present and will throw if
 * called with an empty string.
 */
export async function syncCloudAssistants(
  token: string,
  options?: SyncOptions,
): Promise<SyncResult | null> {
  if (!token) {
    throw new Error(
      "syncCloudAssistants called without a token. Callers must check `readPlatformToken()` first.",
    );
  }
  const log = options?.log;
  const platformUrl = getPlatformUrl();
  log?.(`Platform URL: ${platformUrl}`);
  log?.(`Token found (${token.length} chars, prefix: ${token.slice(0, 6)}…)`);

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
    if (isTimeoutError(err)) {
      console.warn(
        "Warning: platform user lookup timed out — skipping cloud sync",
      );
    }
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
    if (isTimeoutError(err)) {
      console.warn(
        "Warning: platform assistant fetch timed out — using cached data",
      );
    }
    return null;
  }

  if (platformAssistants.length === 0) {
    log?.(
      "Platform returned 0 assistants — this may mean the API returned a non-ok status (check token validity)",
    );
  }

  const platformIds = new Set(platformAssistants.map((a) => a.id));

  // Add new platform assistants not yet in the lockfile
  const existingCloudEntries = loadAllAssistants().filter(
    (a) => a.cloud === "vellum",
  );
  const existingCloudById = new Map(
    existingCloudEntries.map((a) => [a.assistantId, a]),
  );
  const existingCloudIds = new Set(existingCloudById.keys());
  log?.(
    `Lockfile has ${existingCloudIds.size} cloud assistant(s): ${[...existingCloudIds].join(", ") || "(none)"}`,
  );

  let added = 0;
  let updated = 0;
  for (const pa of platformAssistants) {
    const existing = existingCloudById.get(pa.id);
    const assistantName = pa.name.trim();
    const nameFields = assistantName ? { name: assistantName } : {};
    if (!existing) {
      log?.(`Adding ${pa.name || pa.id} to lockfile`);
      saveAssistantEntry({
        assistantId: pa.id,
        ...nameFields,
        runtimeUrl: getPlatformUrl(),
        cloud: "vellum",
        species: "vellum",
        hatchedAt: new Date().toISOString(),
      });
      added++;
    } else if (assistantName && existing.name !== assistantName) {
      log?.(`Updating ${pa.id} name to ${assistantName}`);
      saveAssistantEntry({
        ...existing,
        name: assistantName,
      });
      updated++;
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

  log?.(
    `Sync complete: ${added} added, ${updated} updated, ${removed} removed`,
  );
  return { added, removed, email };
}
