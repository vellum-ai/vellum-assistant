/**
 * Workspace migration `080-restrict-vercel-api-token-metadata`.
 *
 * Repairs legacy Vercel API token credential metadata that was stored
 * with overly permissive policy (e.g. `bash` in allowedTools and
 * injection templates targeting `api.vercel.com`). Rewrites the
 * Vercel record to the hardened policy:
 *
 *   - `allowedTools: ["publish_page", "unpublish_page"]`
 *   - `allowedDomains: []`
 *   - `injectionTemplates` removed
 *
 * Behaviour:
 *   - Missing metadata file -> no-op.
 *   - Malformed JSON -> log and no-op.
 *   - Unrecognized future schema version -> no-op.
 *   - No `vercel`/`api_token` credential record -> no-op.
 *   - Already matches target policy -> no-op (no rewrite, no updatedAt bump).
 *   - Non-Vercel credential records are never modified.
 *
 * Idempotent: running twice produces no second write. The runner's
 * checkpoint also prevents re-runs, but this in-file guard keeps the
 * migration safe even if the checkpoint is wiped.
 *
 * This migration never touches secure secret values — only the
 * metadata policy fields.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-080-restrict-vercel-api-token-metadata",
);

const METADATA_RELATIVE_PATH = join("data", "credentials", "metadata.json");

/** Known on-disk schema versions we can safely handle. */
const KNOWN_VERSIONS = new Set([1, 2, 3, 4, 5]);

/** The hardened target policy for the Vercel API token. */
const TARGET_ALLOWED_TOOLS = ["publish_page", "unpublish_page"];
const TARGET_ALLOWED_DOMAINS: string[] = [];

export const restrictVercelApiTokenMetadataMigration: WorkspaceMigration = {
  id: "080-restrict-vercel-api-token-metadata",
  description:
    "Restrict existing Vercel API token metadata to publish tools only",

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

    // Find the Vercel API token record.
    const vercelIdx = credentials.findIndex(
      (c: unknown) =>
        isPlainObject(c) && c.service === "vercel" && c.field === "api_token",
    );

    if (vercelIdx === -1) {
      // No Vercel credential — nothing to repair.
      return;
    }

    const vercelRecord = credentials[vercelIdx] as Record<string, unknown>;

    // Check if already matches target policy.
    if (alreadyMatchesTarget(vercelRecord)) {
      return;
    }

    // Rewrite the Vercel record to the target policy.
    vercelRecord.allowedTools = TARGET_ALLOWED_TOOLS;
    vercelRecord.allowedDomains = TARGET_ALLOWED_DOMAINS;
    delete vercelRecord.injectionTemplates;
    vercelRecord.updatedAt = Date.now();

    try {
      writeFileSync(metadataPath, JSON.stringify(parsed, null, 2), "utf-8");
      log.info(
        { path: metadataPath },
        "Repaired Vercel API token metadata to hardened policy",
      );
    } catch (err) {
      log.warn(
        { err, path: metadataPath },
        "Failed to write repaired credentials metadata; leaving prior file in place",
      );
    }
  },

  down(_workspaceDir: string): void {
    // Cannot recover the original vulnerable policy — and we would not
    // want to even if we could. This is a security hardening migration.
  },
};

/**
 * Returns true when the Vercel record already matches the target
 * hardened policy, meaning no rewrite is necessary.
 */
function alreadyMatchesTarget(record: Record<string, unknown>): boolean {
  const tools = record.allowedTools;
  const domains = record.allowedDomains;

  if (!Array.isArray(tools) || tools.length !== TARGET_ALLOWED_TOOLS.length) {
    return false;
  }
  const sortedTools = [...tools].sort();
  const sortedTarget = [...TARGET_ALLOWED_TOOLS].sort();
  for (let i = 0; i < sortedTools.length; i++) {
    if (sortedTools[i] !== sortedTarget[i]) return false;
  }

  if (!Array.isArray(domains) || domains.length !== 0) {
    return false;
  }

  // injectionTemplates must be absent or undefined.
  if (
    "injectionTemplates" in record &&
    record.injectionTemplates !== undefined &&
    record.injectionTemplates !== null
  ) {
    return false;
  }

  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
