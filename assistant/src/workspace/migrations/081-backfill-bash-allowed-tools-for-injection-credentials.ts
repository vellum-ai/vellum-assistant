/**
 * Workspace migration `081-backfill-bash-allowed-tools-for-injection-credentials`.
 *
 * After migration 080 stripped Vercel's injection templates and locked
 * its `allowedTools` to `["publish_page", "unpublish_page"]`, the new
 * shell.ts credential policy enforcement (`isToolAllowed("bash", meta.allowedTools)`)
 * would reject every other service that legitimately uses proxied bash
 * via injection templates — because their `allowedTools` was never populated.
 *
 * This migration backfills `"bash"` into `allowedTools` for any credential
 * that:
 *   1. Has a non-empty `injectionTemplates` array (i.e., it uses proxied bash).
 *   2. Has empty or missing `allowedTools`.
 *
 * Credentials that already have populated `allowedTools` (like the
 * now-hardened Vercel credential) are NOT touched.
 *
 * Behaviour:
 *   - Missing metadata file -> no-op.
 *   - Malformed JSON -> log and no-op.
 *   - Unrecognized future schema version -> no-op.
 *   - No qualifying credentials -> no-op (no rewrite).
 *   - Already backfilled -> no-op (idempotent).
 *
 * Idempotent: running twice produces no second write.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-081-backfill-bash-allowed-tools-for-injection-credentials",
);

const METADATA_RELATIVE_PATH = join("data", "credentials", "metadata.json");

/** Known on-disk schema versions we can safely handle. */
const KNOWN_VERSIONS = new Set([1, 2, 3, 4, 5]);

export const backfillBashAllowedToolsForInjectionCredentialsMigration: WorkspaceMigration =
  {
    id: "081-backfill-bash-allowed-tools-for-injection-credentials",
    description:
      "Backfill bash into allowedTools for credentials with injection templates",

    run(workspaceDir: string): void {
      const metadataPath = join(workspaceDir, METADATA_RELATIVE_PATH);
      if (!existsSync(metadataPath)) {
        return;
      }

      let raw: string;
      try {
        raw = readFileSync(metadataPath, "utf-8");
      } catch (err) {
        log.warn(
          { err, path: metadataPath },
          "Failed to read credentials metadata; skipping migration",
        );
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        log.warn(
          { err, path: metadataPath },
          "Failed to parse credentials metadata JSON; skipping migration",
        );
        return;
      }

      if (!isPlainObject(parsed)) {
        log.warn(
          { path: metadataPath },
          "Credentials metadata is not an object; skipping migration",
        );
        return;
      }

      // Respect unrecognized future schema versions — do not touch the file.
      const version = typeof parsed.version === "number" ? parsed.version : 1;
      if (!KNOWN_VERSIONS.has(version)) {
        log.info(
          { version, path: metadataPath },
          "Credentials metadata has unrecognized version; skipping migration",
        );
        return;
      }

      const credentials = Array.isArray(parsed.credentials)
        ? parsed.credentials
        : [];

      let modified = false;

      for (const cred of credentials) {
        if (!isPlainObject(cred)) continue;

        // Only target credentials with non-empty injectionTemplates.
        if (!hasNonEmptyInjectionTemplates(cred)) continue;

        // Only target credentials with empty or missing allowedTools.
        if (hasPopulatedAllowedTools(cred)) continue;

        // Backfill "bash" into allowedTools.
        cred.allowedTools = ["bash"];
        cred.updatedAt = Date.now();
        modified = true;
      }

      if (!modified) {
        return;
      }

      try {
        writeFileSync(metadataPath, JSON.stringify(parsed, null, 2), "utf-8");
        log.info(
          { path: metadataPath },
          "Backfilled bash into allowedTools for credentials with injection templates",
        );
      } catch (err) {
        log.warn(
          { err, path: metadataPath },
          "Failed to write backfilled credentials metadata; leaving prior file in place",
        );
      }
    },

    down(_workspaceDir: string): void {
      // This is a forward-only data repair. Rolling back would re-break
      // proxied bash for affected services.
    },
  };

/**
 * Returns true when the credential has a non-empty `injectionTemplates` array.
 */
function hasNonEmptyInjectionTemplates(
  record: Record<string, unknown>,
): boolean {
  const templates = record.injectionTemplates;
  return Array.isArray(templates) && templates.length > 0;
}

/**
 * Returns true when the credential has a populated (non-empty) `allowedTools` array.
 */
function hasPopulatedAllowedTools(record: Record<string, unknown>): boolean {
  const tools = record.allowedTools;
  return Array.isArray(tools) && tools.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
