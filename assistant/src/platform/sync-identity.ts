/**
 * Sync assistant identity fields to the platform Assistant record.
 *
 * When IDENTITY.md changes on disk the daemon broadcasts an
 * `identity_changed` event to connected clients. This module hooks into that
 * same change signal and PATCHes the platform `Assistant` record through the
 * shared platform PATCH queue so the name stays in sync: rapid changes
 * collapse to the newest name, and an unchanged name is not re-sent to the
 * same platform destination.
 */

import { existsSync, readFileSync } from "node:fs";

import { parseIdentityFields } from "../daemon/handlers/identity.js";
import { getLogger } from "../util/logger.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import { createPlatformPatchQueue } from "./platform-patch-queue.js";

const log = getLogger("sync-identity");

const queue = createPlatformPatchQueue<string>({
  log,
  label: "assistant name",
  buildPayload: (name) => ({
    key: name,
    body: { name },
  }),
});

/**
 * Push the current assistant name to the platform `Assistant` record.
 * Empty names are ignored.
 */
export function syncIdentityNameToPlatform(name: string): void {
  if (name) {
    queue.enqueue(name);
  }
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
