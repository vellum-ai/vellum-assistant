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
 *     rows (best effort, see below)
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
 * The DB rewrite is best effort: a missing, locked, or unqueryable database
 * is logged and skipped rather than blocking the config repair. A stranded
 * conversation or schedule pin degrades to the default profile selection,
 * which is the documented behaviour for a pin whose profile no longer
 * exists, while leaving the config unrepaired would keep the user's profile
 * shadowed by ours.
 *
 * Idempotent: after a successful run no workspace-owned profile carries a
 * reserved backup name, so a re-run finds nothing to rename and writes
 * nothing.
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

export const renameCollidingBackupProfileNamesMigration: WorkspaceMigration = {
  id: "147-rename-colliding-backup-profile-names",
  description:
    "Rename user profiles colliding with the reserved managed backup keys and rewrite their references",
  retryFailedCheckpoint: true,

  run(workspaceDir: string): void {
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

    // The DB rewrite runs first so an interrupted migration re-runs with the
    // config still holding the old keys, i.e. with the mapping intact.
    rewriteDbReferences(workspaceDir, renames);

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
 * per-conversation profile and the per-schedule profile. Best effort, see
 * the file header.
 */
function rewriteDbReferences(
  workspaceDir: string,
  renames: Map<string, string>,
): void {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return;
  }
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch (err) {
    log.warn({ err }, "Could not open the database to repoint profile pins");
    return;
  }
  try {
    for (const table of ["conversations", "cron_jobs"]) {
      for (const [from, to] of renames) {
        try {
          db.query(
            `UPDATE ${table} SET inference_profile = ? WHERE inference_profile = ?`,
          ).run(to, from);
        } catch (err) {
          log.warn(
            { err, table, from, to },
            "Could not repoint profile pins on this table; stranded pins fall back to the default selection",
          );
        }
      }
    }
  } finally {
    db.close();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}
