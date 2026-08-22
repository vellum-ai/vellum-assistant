/**
 * Workspace migration `147-rename-colliding-backup-profile-names`.
 *
 * The four managed backup profile keys (`balanced-backup`,
 * `quality-optimized-backup`, `cost-optimized-backup`,
 * `latency-optimized-backup`) became reserved code-owned names. From that
 * release on, a name in the code-owned set resolves to the code body no
 * matter what `llm.profiles` holds, so a user-created profile that happens
 * to carry one of those names is silently replaced in the effective catalog:
 * the user's own model, provider, and tuning stop being what their
 * `activeProfile`, call-site pin, mix arm, or `fallbackProfile` reference
 * routes through.
 *
 * This migration runs before the reservation can take effect (workspace
 * migrations run ahead of the first config load and the profile seeder) and
 * gives any such profile a fresh key, rewriting every reference to it so the
 * user keeps both the profile and its wiring:
 *
 *   - `llm.profiles` key (insertion order preserved)
 *   - `llm.activeProfile`, `llm.advisorProfile`
 *   - `llm.profileOrder` entries
 *   - `llm.callSites.<site>.profile` pins
 *   - `llm.profiles.<key>.mix[].profile` arms
 *   - `llm.profiles.<key>.fallbackProfile` targets
 *   - `conversations.inference_profile` and `cron_jobs.inference_profile`
 *     rows (see below)
 *
 * The new key is `<name>-custom`, suffixed `-custom-2`, `-custom-3`, ... when
 * that is taken. Candidates are checked against every existing profile key
 * AND every reserved code-defined name, so a rename never lands on another
 * name the catalog owns.
 *
 * Only workspace-owned profiles are renamed. An entry whose `source` is
 * `managed` is a thin stub for a code-owned profile, not a user profile, and
 * a non-object value under one of these keys is not a profile at all (the
 * loader strips it); both are left alone.
 *
 * The DB rewrite is NOT best effort. A pin the rewrite abandons does not
 * degrade to the default selection: its old name is now a reserved code-owned
 * key, so the conversation or schedule silently starts routing through the
 * managed backup instead of the user's profile. So a database that exists but
 * cannot be opened or written is retried a bounded number of times with a
 * short backoff, and a failure that outlives the retries throws. The runner
 * then records a `failed` checkpoint, and `retryFailedCheckpoint` makes the
 * next boot re-run the whole migration. An absent database file is a real
 * state (no pins to strand) and a table the schema does not carry yet is
 * nothing to rewrite; both are skipped without failing.
 *
 * The DB rewrite deliberately runs BEFORE the config write, so a throw leaves
 * config.json holding the old keys and the next run rebuilds the same
 * mapping from it.
 *
 * Idempotent: after a successful run no workspace-owned profile carries a
 * reserved backup name, so a re-run finds nothing to rename and writes
 * nothing. The pin rewrite matches on the old name, so re-running it after a
 * partial pass is a no-op on the rows already repointed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger(
  "workspace-migration-147-rename-colliding-backup-profile-names",
);

/**
 * The newly reserved keys this migration clears. Frozen snapshot of
 * `BACKUP_PROFILE_KEYS` as of 2026-08-21 (migrations are self-contained).
 */
const BACKUP_PROFILE_KEYS = [
  "balanced-backup",
  "quality-optimized-backup",
  "cost-optimized-backup",
  "latency-optimized-backup",
];

/**
 * Every code-defined profile name as of 2026-08-21: the default keys, the
 * backups, and the flag-gated `os-beta`. A renamed profile must not land on
 * any of them, or the rename would just move the collision.
 */
const RESERVED_PROFILE_NAMES = new Set<string>([
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "latency-optimized",
  ...BACKUP_PROFILE_KEYS,
  "os-beta",
]);

const RENAME_SUFFIX = "-custom";

/** Total attempts at the pin rewrite, the first one included. */
const DB_ATTEMPTS = 4;

/** First backoff step; each further wait doubles it (50, 100, 200 ms). */
const DB_RETRY_BASE_DELAY_MS = 50;

export const renameCollidingBackupProfileNamesMigration: WorkspaceMigration = {
  id: "147-rename-colliding-backup-profile-names",
  description:
    "Rename user profiles colliding with the reserved managed backup keys and rewrite their references",
  // The failure this migration can hit is a database it cannot write, and
  // both halves of the run are idempotent, so a failed checkpoint is worth
  // re-running: the config still holds the old keys, the mapping rebuilds
  // from them, and the pin rewrite matches on the old name.
  retryFailedCheckpoint: true,

  async run(workspaceDir: string): Promise<void> {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

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

    const renames = planRenames(profiles);
    if (renames.size === 0) {
      return;
    }

    // The DB rewrite runs first so an interrupted or failed migration re-runs
    // with the config still holding the old keys, i.e. with the mapping
    // intact. A rewrite that cannot be completed throws out of here, which
    // stops the config rename below rather than stranding the pins.
    await rewriteDbReferences(workspaceDir, renames);

    llm.profiles = renameProfileKeys(profiles, renames);
    rewriteConfigReferences(llm, renames);

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log.info(
      { renames: Object.fromEntries(renames) },
      "Renamed user profiles colliding with reserved managed backup keys",
    );
  },

  down(_workspaceDir: string): void {
    // Forward-only: the reserved names cannot be handed back.
  },
};

/**
 * Old key -> new key for every workspace-owned profile sitting on a reserved
 * backup name. Deterministic: keys are considered in `BACKUP_PROFILE_KEYS`
 * order and each assigned name is reserved against later candidates, so the
 * same config always produces the same mapping.
 */
function planRenames(profiles: Record<string, unknown>): Map<string, string> {
  const renames = new Map<string, string>();
  const taken = new Set<string>([
    ...Object.keys(profiles),
    ...RESERVED_PROFILE_NAMES,
  ]);

  for (const key of BACKUP_PROFILE_KEYS) {
    if (!(key in profiles)) {
      continue;
    }
    const entry = asObject(profiles[key]);
    if (entry === null) {
      log.warn(
        { profile: key },
        "Left a non-object value under a reserved backup key; it is not a profile to preserve",
      );
      continue;
    }
    if (entry.source === "managed") {
      // A managed stub is the workspace's overlay slot for a code-owned
      // profile, not a user profile. Backups take no overlay, so the stub is
      // inert; renaming it would manufacture a phantom user profile.
      continue;
    }
    let candidate = `${key}${RENAME_SUFFIX}`;
    let counter = 2;
    while (taken.has(candidate)) {
      candidate = `${key}${RENAME_SUFFIX}-${counter}`;
      counter += 1;
    }
    taken.add(candidate);
    renames.set(key, candidate);
  }

  return renames;
}

/** Rebuild the profiles record with the renamed keys, preserving order. */
function renameProfileKeys(
  profiles: Record<string, unknown>,
  renames: Map<string, string>,
): Record<string, unknown> {
  const renamed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(profiles)) {
    renamed[renames.get(name) ?? name] = value;
  }
  return renamed;
}

/** Point every config reference at the renamed key. */
function rewriteConfigReferences(
  llm: Record<string, unknown>,
  renames: Map<string, string>,
): void {
  for (const field of ["activeProfile", "advisorProfile"]) {
    const current = llm[field];
    if (typeof current === "string" && renames.has(current)) {
      llm[field] = renames.get(current);
    }
  }

  if (Array.isArray(llm.profileOrder)) {
    llm.profileOrder = (llm.profileOrder as unknown[]).map((name) =>
      typeof name === "string" ? (renames.get(name) ?? name) : name,
    );
  }

  const callSites = asObject(llm.callSites);
  if (callSites !== null) {
    for (const value of Object.values(callSites)) {
      const site = asObject(value);
      if (
        site !== null &&
        typeof site.profile === "string" &&
        renames.has(site.profile)
      ) {
        site.profile = renames.get(site.profile);
      }
    }
  }

  const profiles = asObject(llm.profiles);
  if (profiles === null) {
    return;
  }
  for (const value of Object.values(profiles)) {
    const entry = asObject(value);
    if (entry === null) {
      continue;
    }
    if (
      typeof entry.fallbackProfile === "string" &&
      renames.has(entry.fallbackProfile)
    ) {
      entry.fallbackProfile = renames.get(entry.fallbackProfile);
    }
    if (!Array.isArray(entry.mix)) {
      continue;
    }
    for (const armValue of entry.mix as unknown[]) {
      const arm = asObject(armValue);
      if (
        arm !== null &&
        typeof arm.profile === "string" &&
        renames.has(arm.profile)
      ) {
        arm.profile = renames.get(arm.profile);
      }
    }
  }
}

/**
 * Repoint the profile pins stored outside config.json: the sticky
 * per-conversation profile and the per-schedule profile.
 *
 * Retried as a whole rather than per statement: opening the database, reading
 * `sqlite_master` and running the updates all fail the same way under write
 * contention (`SQLITE_BUSY` from a second connection), and every step is
 * idempotent, so re-running the block is the simplest recovery that cannot
 * double-apply. A failure that outlives the attempts throws, which fails the
 * migration for `retryFailedCheckpoint` to pick up on the next boot.
 */
async function rewriteDbReferences(
  workspaceDir: string,
  renames: Map<string, string>,
): Promise<void> {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    // No database yet, so there are no pins that could be stranded.
    return;
  }
  await withDbRetry(() => {
    const db = new Database(dbPath);
    try {
      for (const table of ["conversations", "cron_jobs"]) {
        const present = db
          .query(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
          )
          .get(table);
        if (!present) {
          // A workspace whose schema does not carry this table holds no pins
          // in it. Nothing to rewrite, and nothing to fail over.
          log.info({ table }, "No profile pin table to repoint");
          continue;
        }
        for (const [from, to] of renames) {
          db.query(
            `UPDATE ${table} SET inference_profile = ? WHERE inference_profile = ?`,
          ).run(to, from);
        }
      }
    } finally {
      db.close();
    }
  });
}

/**
 * Run the pin rewrite, retrying a transient database failure with a short
 * doubling backoff. Rethrows once the attempts are spent so the caller stops
 * before the config rename.
 */
async function withDbRetry(attempt: () => void): Promise<void> {
  for (let index = 0; ; index += 1) {
    try {
      attempt();
      return;
    } catch (err) {
      if (index >= DB_ATTEMPTS - 1) {
        throw new Error(
          `Could not repoint conversation and schedule profile pins after ${DB_ATTEMPTS} attempts; leaving the config unrenamed so the next boot retries`,
          { cause: err },
        );
      }
      log.warn(
        { err, attempt: index },
        "Could not repoint profile pins; retrying",
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
