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
 * response cannot overwrite a newer value. The dedup key is scoped to the
 * platform destination (base URL + assistant id) so re-registering to
 * another assistant re-sends an unchanged name.
 *
 * The sync is best-effort and fire-and-forget — network failures are
 * logged but never surface to callers.
 */

import { existsSync, readFileSync } from "node:fs";

import { parseIdentityFields } from "../daemon/handlers/identity.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { VellumPlatformClient } from "./client.js";

const log = getLogger("sync-identity");

/** `${baseUrl}|${assistantId}|${name}` of the last successful PATCH. */
let lastSyncedKey: string | null = null;

/**
 * Monotonically increasing sequence number.  Each call to
 * `syncIdentityNameToPlatform` bumps this; a request whose seq is no longer
 * current is skipped, guaranteeing the newest name always wins.
 */
let seq = 0;

/** Chain promise that serializes in-flight PATCH requests. */
let pending: Promise<void> = Promise.resolve();

export function _resetSyncIdentityStateForTests(): void {
  lastSyncedKey = null;
  seq = 0;
  pending = Promise.resolve();
}

/**
 * Push the current assistant name to the platform `Assistant` record.
 *
 * No-op when:
 * - The platform client cannot be created (not platform-hosted / missing creds).
 * - No assistant ID is configured.
 * - The name is empty or already synced to the same platform destination.
 */
export function syncIdentityNameToPlatform(name: string): void {
  if (!name) {
    return;
  }

  const mySeq = ++seq;

  pending = pending
    .then(() => doSync(name, mySeq))
    .catch(() => {
      // swallowed — doSync already logs internally
    });
}

/**
 * Read the workspace IDENTITY.md and best-effort sync the assistant name to
 * the platform record. Called once at daemon startup; later edits are picked
 * up by the config watcher's IDENTITY.md change reaction.
 */
export function syncWorkspaceIdentityToPlatform(): void {
  try {
    const identityPath = getWorkspacePromptPath("IDENTITY.md");
    const content = existsSync(identityPath)
      ? readFileSync(identityPath, "utf-8")
      : "";
    const fields = parseIdentityFields(content);
    if (fields.name) {
      syncIdentityNameToPlatform(fields.name);
    }
  } catch (err) {
    log.error({ err }, "Failed to sync identity to platform at startup");
  }
}

async function doSync(name: string, requestSeq: number): Promise<void> {
  try {
    // A newer call has already been enqueued — skip this stale request.
    if (requestSeq !== seq) {
      return;
    }

    const client = await VellumPlatformClient.create();
    const assistantId = client?.platformAssistantId;
    if (!client || !assistantId) {
      return;
    }

    const key = `${client.baseUrl}|${assistantId}|${name}`;
    if (key === lastSyncedKey) {
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
      lastSyncedKey = key;
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
