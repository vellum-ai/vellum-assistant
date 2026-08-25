/**
 * Workspace migration `149-repoint-backup-profile-selections`.
 *
 * Managed backup profiles are internal failover routes. Earlier builds let
 * users select those names directly, so existing workspaces can retain them
 * in active, advisor, call-site, mix, conversation, or schedule references.
 * Repoint those direct selections to their corresponding primary profile
 * before the user-facing catalog hides the backups. Automatic fallback
 * metadata is preserved: a primary's `fallbackProfile` still names its
 * internal backup route.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { FALLBACK_PROFILE_BY_KEY } from "../../config/default-profile-names.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-149-repoint-backup-profile-selections",
);

/** Mapping of every managed backup to its direct-selectable primary. */
const BACKUP_TO_PRIMARY: Record<string, string> = Object.fromEntries(
  Object.entries(FALLBACK_PROFILE_BY_KEY).map(([primary, backup]) => [
    backup,
    primary,
  ]),
);

const PROFILE_PIN_TABLES = ["conversations", "cron_jobs"] as const;
const DB_ATTEMPTS = 4;
const DB_RETRY_BASE_DELAY_MS = 50;

export const repointBackupProfileSelectionsMigration: WorkspaceMigration = {
  id: "149-repoint-backup-profile-selections",
  description:
    "Repoint direct selections of managed backup profiles to their primaries",
  retryFailedCheckpoint: true,

  async run(workspaceDir: string): Promise<void> {
    const configPath = join(workspaceDir, "config.json");
    const config = readConfig(configPath);
    const llm = config === null ? null : asObject(config.llm);
    const configChanged = llm !== null && rewriteConfigReferences(llm);

    // Rewrite database pins before config.json. If the database cannot be
    // updated, leaving config untouched lets the next boot retry the same
    // migration without stranding a direct selection.
    await rewriteDbReferences(workspaceDir);

    if (config !== null && configChanged) {
      const tempPath = `${configPath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
      renameSync(tempPath, configPath);
      log.info("Repointed direct backup-profile selections to primaries");
    }
  },

  down(_workspaceDir: string): void {
    // Forward-only: restoring a backup selection would make it unreachable
    // from the user-facing profile catalog.
  },
};

function readConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Rewrite config references that represent direct user profile choices. */
function rewriteConfigReferences(llm: Record<string, unknown>): boolean {
  let changed = false;

  for (const field of ["activeProfile", "advisorProfile"] as const) {
    const current = llm[field];
    const replacement = remapProfileName(current);
    if (replacement !== current) {
      llm[field] = replacement;
      changed = true;
    }
  }

  const callSites = asObject(llm.callSites);
  if (callSites !== null) {
    for (const value of Object.values(callSites)) {
      const site = asObject(value);
      if (site === null) {
        continue;
      }
      const replacement = remapProfileName(site.profile);
      if (replacement !== site.profile) {
        site.profile = replacement;
        changed = true;
      }
    }
  }

  const profiles = asObject(llm.profiles);
  if (profiles === null) {
    return changed;
  }
  for (const value of Object.values(profiles)) {
    const entry = asObject(value);
    if (entry === null || !Array.isArray(entry.mix)) {
      continue;
    }
    for (const armValue of entry.mix as unknown[]) {
      const arm = asObject(armValue);
      if (arm === null) {
        continue;
      }
      const replacement = remapProfileName(arm.profile);
      if (replacement !== arm.profile) {
        arm.profile = replacement;
        changed = true;
      }
    }
  }

  return changed;
}

function remapProfileName(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return BACKUP_TO_PRIMARY[value] ?? value;
}

/** Rewrite conversation and schedule pins, retrying transient DB contention. */
async function rewriteDbReferences(workspaceDir: string): Promise<void> {
  const path = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(path)) {
    return;
  }

  await withDbRetry(() => {
    const db = new Database(path);
    try {
      for (const table of PROFILE_PIN_TABLES) {
        if (!tableHasColumn(db, table, "inference_profile")) {
          continue;
        }
        for (const [backup, primary] of Object.entries(BACKUP_TO_PRIMARY)) {
          db.query(
            `UPDATE ${table} SET inference_profile = ? WHERE inference_profile = ?`,
          ).run(primary, backup);
        }
      }
    } finally {
      db.close();
    }
  });
}

function tableHasColumn(
  db: Database,
  table: (typeof PROFILE_PIN_TABLES)[number],
  column: string,
): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name?: unknown;
  }>;
  return rows.some((row) => row.name === column);
}

async function withDbRetry(attempt: () => void): Promise<void> {
  for (let index = 0; ; index += 1) {
    try {
      attempt();
      return;
    } catch (err) {
      if (index >= DB_ATTEMPTS - 1) {
        throw new Error(
          `Could not repoint backup-profile selections after ${DB_ATTEMPTS} attempts`,
          { cause: err },
        );
      }
      log.warn(
        { err, attempt: index },
        "Could not repoint backup-profile selections; retrying",
      );
      await Bun.sleep(DB_RETRY_BASE_DELAY_MS * 2 ** index);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}
