/**
 * Sync assistant identity fields to the platform Assistant record.
 *
 * When IDENTITY.md changes on disk the daemon broadcasts an
 * `identity_changed` event to connected clients.  This module hooks into
 * that same change signal and PATCHes the platform `Assistant` record so
 * the name (and, in future, other fields) stays in sync.
 *
 * Requests are serialized so that rapid name changes (A → B) never race:
 * only the most recently requested name is sent, and a stale in-flight
 * response cannot overwrite a newer value.
 *
 * The sync is best-effort and fire-and-forget — network failures are
 * logged but never surface to callers.
 */

import { getLogger } from "../util/logger.js";
import { VellumPlatformClient } from "./client.js";

const log = getLogger("sync-identity");

/** Track the last successfully synced name (used inside doSync to skip redundant PATCHes). */
let lastSyncedName: string | null = null;

/** Track the last requested name (used for dedup at enqueue time). */
let lastRequestedName: string | null = null;

/**
 * Monotonically increasing sequence number.  Each call to
 * `syncIdentityNameToPlatform` bumps this; after a PATCH completes we
 * only update `lastSyncedName` when `seq` still matches, guaranteeing
 * the newest name always wins.
 */
let seq = 0;

/** Chain promise that serializes in-flight PATCH requests. */
let pending: Promise<void> = Promise.resolve();

/**
 * Push the current assistant name to the platform `Assistant` record.
 *
 * No-op when:
 * - The platform client cannot be created (not platform-hosted / missing creds).
 * - No assistant ID is configured.
 * - The name is empty or unchanged since the last request.
 */
export function syncIdentityNameToPlatform(name: string): void {
  if (!name || name === lastRequestedName) return;

  lastRequestedName = name;

  const mySeq = ++seq;

  pending = pending
    .then(() => doSync(name, mySeq))
    .catch(() => {
      // swallowed — doSync already logs internally
    });
}

async function doSync(name: string, requestSeq: number): Promise<void> {
  try {
    // A newer call has already been enqueued — skip this stale request.
    if (requestSeq !== seq) return;

    // Re-check after awaiting the previous request in the chain.
    if (name === lastSyncedName) return;

    const client = await VellumPlatformClient.create();
    if (!client) {
      clearRequestedIfLatest(requestSeq);
      return;
    }

    const assistantId = client.platformAssistantId;
    if (!assistantId) {
      clearRequestedIfLatest(requestSeq);
      return;
    }

    const resp = await client.fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (resp.ok) {
      // Only update cache if no newer request has been enqueued since we
      // started this PATCH — prevents a slow response from overwriting a
      // fresher value.
      if (requestSeq === seq) {
        lastSyncedName = name;
      }
      log.info({ name, assistantId }, "Synced assistant name to platform");
    } else {
      clearRequestedIfLatest(requestSeq);
      const text = await resp.text();
      log.warn(
        { status: resp.status, body: text, assistantId },
        "Failed to sync assistant name to platform",
      );
    }
  } catch (err) {
    clearRequestedIfLatest(requestSeq);
    log.warn({ err }, "Error syncing assistant name to platform");
  }
}

/**
 * Reset `lastRequestedName` when the latest request failed, so that the
 * next call with the same name is allowed through instead of being deduped.
 */
function clearRequestedIfLatest(requestSeq: number): void {
  if (requestSeq === seq) {
    lastRequestedName = lastSyncedName;
  }
}

/** Reset cached state (for testing). */
export function _resetSyncState(): void {
  lastSyncedName = null;
  lastRequestedName = null;
  seq = 0;
  pending = Promise.resolve();
}
