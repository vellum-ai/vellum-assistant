/**
 * Sync assistant identity fields to the platform Assistant record.
 *
 * When IDENTITY.md changes on disk the daemon broadcasts an
 * `identity_changed` event to connected clients.  This module hooks into
 * that same change signal and PATCHes the platform `Assistant` record so
 * the name (and, in future, other fields) stays in sync.
 *
 * The sync is best-effort and fire-and-forget — network failures are
 * logged but never surface to callers.
 */

import { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";

const log = getLogger("sync-identity");

/** Track the last synced name to avoid redundant PATCH calls. */
let lastSyncedName: string | null = null;

/**
 * Push the current assistant name to the platform `Assistant` record.
 *
 * No-op when:
 * - The platform client cannot be created (not platform-hosted / missing creds).
 * - No assistant ID is configured.
 * - The name is empty or unchanged since the last successful sync.
 */
export async function syncIdentityNameToPlatform(name: string): Promise<void> {
  try {
    if (!name || name === lastSyncedName) return;

    const client = await VellumPlatformClient.create();
    if (!client) return;

    const assistantId = client.platformAssistantId;
    if (!assistantId) return;

    const resp = await client.fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );

    if (resp.ok) {
      lastSyncedName = name;
      log.info({ name, assistantId }, "Synced assistant name to platform");
    } else {
      const text = await resp.text();
      log.warn(
        { status: resp.status, body: text, assistantId },
        "Failed to sync assistant name to platform",
      );
    }
  } catch (err) {
    log.warn({ err }, "Error syncing assistant name to platform");
  }
}

/** Reset cached state (for testing). */
export function _resetSyncState(): void {
  lastSyncedName = null;
}
