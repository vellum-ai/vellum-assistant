/**
 * Workspace migration `148-strip-unsupported-fallback-profiles`.
 *
 * Automatic model fallbacks are code-owned metadata on the four managed
 * default profiles. Earlier builds accepted custom `fallbackProfile` values
 * in raw workspace config, including pointers rewritten by migration 147.
 * Those values cannot be executed under the managed-only fallback contract
 * and would make later config writes fail validation.
 *
 * This migration removes every persisted pointer except the exact managed
 * default mapping while managed backups resolve under the selected provider.
 * It runs before config parsing, so legacy values are cleaned up without
 * depending on schema salvage. The operation is idempotent: a second run
 * finds no unsupported fields and writes nothing.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-148-strip-unsupported-fallback-profiles",
);

/** Frozen snapshot of the code-owned fallback mapping as of 2026-08-24. */
const CODE_OWNED_FALLBACKS: Record<string, string> = {
  balanced: "balanced-backup",
  "quality-optimized": "quality-optimized-backup",
  "cost-optimized": "cost-optimized-backup",
  "latency-optimized": "latency-optimized-backup",
};

export const stripUnsupportedFallbackProfilesMigration: WorkspaceMigration = {
  id: "148-strip-unsupported-fallback-profiles",
  description:
    "Remove custom fallback profile pointers outside the managed default contract",
  // A transient config write failure must not leave an unsupported pointer
  // behind permanently; the next boot can safely repeat this idempotent pass.
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    let config: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!isPlainObject(parsed)) {
        return;
      }
      config = parsed;
    } catch {
      return;
    }

    const llm = asObject(config.llm);
    const profiles = llm === null ? null : asObject(llm.profiles);
    if (llm === null || profiles === null) {
      return;
    }
    const backupsResolve = backupProfilesResolveUnderDefaultProvider(
      llm.defaultProvider,
    );

    const strippedProfiles: string[] = [];
    for (const [name, value] of Object.entries(profiles)) {
      const entry = asObject(value);
      if (
        entry === null ||
        !Object.prototype.hasOwnProperty.call(entry, "fallbackProfile")
      ) {
        continue;
      }
      const isCodeOwnedMapping =
        backupsResolve &&
        entry.source === "managed" &&
        entry.fallbackProfile === CODE_OWNED_FALLBACKS[name];
      if (isCodeOwnedMapping) {
        continue;
      }
      delete entry.fallbackProfile;
      strippedProfiles.push(name);
    }

    if (strippedProfiles.length === 0) {
      return;
    }
    const tempPath = `${configPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    renameSync(tempPath, configPath);
    log.info(
      { profiles: strippedProfiles },
      "Removed unsupported custom fallback profile pointers",
    );
  },

  down(_workspaceDir: string): void {
    // Forward-only: unsupported fallback pointers cannot be restored safely.
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

function backupProfilesResolveUnderDefaultProvider(
  defaultProvider: unknown,
): boolean {
  const provider = isPlainObject(defaultProvider)
    ? defaultProvider.provider
    : undefined;
  return typeof provider !== "string" || provider === "vellum";
}
