/**
 * `vellum backup` — manage automated backups, on-demand snapshots, restore, and verify.
 *
 * All subcommands run in-process (they do not call the daemon HTTP port).
 * Config mutations go through `loadRawConfig` / `setNestedValue` / `saveRawConfig`
 * so the on-disk `config.json` is the single source of truth and the daemon's
 * config cache is invalidated via `saveRawConfig`.
 */

import { stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { Command } from "commander";

import { readBackupKey } from "../../backup/backup-key.js";
import { createSnapshotNow } from "../../backup/backup-worker.js";
import {
  listSnapshotsInDir,
  type SnapshotEntry,
} from "../../backup/list-snapshots.js";
import {
  getBackupKeyPath,
  getLocalBackupsDir,
  resolveOffsiteDestinations,
} from "../../backup/paths.js";
import { restoreFromSnapshot, verifySnapshot } from "../../backup/restore.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import type { BackupDestination } from "../../config/schema.js";
import { isDaemonRunning } from "../../daemon/daemon-control.js";
import { getMemoryCheckpoint } from "../../memory/checkpoints.js";
import { resetDb } from "../../memory/db-connection.js";
import { clearCache as clearTrustCache } from "../../permissions/trust-store.js";
import { DefaultPathResolver } from "../../runtime/migrations/vbundle-import-analyzer.js";
import {
  getWorkspaceDir,
  getWorkspaceHooksDir,
} from "../../util/platform.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** Format a byte count as a human-readable string (B / KB / MB / GB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Format a Date as `YYYY-MM-DD HH:MM UTC`. */
function formatDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const mo = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const h = date.getUTCHours().toString().padStart(2, "0");
  const mi = date.getUTCMinutes().toString().padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi} UTC`;
}

/**
 * Format a duration (milliseconds) as a short human string: "3h 12m",
 * "12m", "45s", or "just now".
 */
function formatDurationShort(ms: number): string {
  if (ms < 0) ms = 0;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 30) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes - hours * 60;
  if (hours < 1) return `${minutes}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours - days * 24;
  if (days < 1) return `${hours}h ${remMinutes}m`;
  return `${days}d ${remHours}h`;
}

// ---------------------------------------------------------------------------
// Reachability probe
// ---------------------------------------------------------------------------

/**
 * Check whether an offsite destination's parent directory exists. Mirrors the
 * reachability check in `offsite-writer.ts` — if the parent is missing (e.g.
 * iCloud Drive not enabled, external SSD unplugged) the destination is
 * considered unreachable and we skip it at runtime.
 */
async function isDestinationReachable(destPath: string): Promise<boolean> {
  try {
    await stat(dirname(destPath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exported handlers — exported so tests can drive them directly.
// ---------------------------------------------------------------------------

export interface EnableOptions {
  interval?: string;
  retention?: string;
  offsite?: boolean;
}

export function handleEnable(opts: EnableOptions): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "backup.enabled", true);

  if (opts.interval !== undefined) {
    const hours = Number.parseInt(opts.interval, 10);
    if (!Number.isFinite(hours) || hours < 1) {
      log.error(
        `Invalid --interval "${opts.interval}". Must be a positive integer (hours). ` +
          `Run 'vellum backup enable --help' for usage.`,
      );
      process.exitCode = 1;
      return;
    }
    setNestedValue(raw, "backup.intervalHours", hours);
  }

  if (opts.retention !== undefined) {
    const count = Number.parseInt(opts.retention, 10);
    if (!Number.isFinite(count) || count < 1) {
      log.error(
        `Invalid --retention "${opts.retention}". Must be a positive integer. ` +
          `Run 'vellum backup enable --help' for usage.`,
      );
      process.exitCode = 1;
      return;
    }
    setNestedValue(raw, "backup.retention", count);
  }

  // commander's `.option("--no-offsite", ...)` sets `opts.offsite = false`
  // when the flag is present and leaves it `undefined` otherwise. Only a
  // literal `false` flips the offsite switch — we never touch `destinations`.
  if (opts.offsite === false) {
    setNestedValue(raw, "backup.offsite.enabled", false);
  }

  saveRawConfig(raw);

  const cfg = getConfig().backup;
  log.info(
    `Automatic backups enabled (interval=${cfg.intervalHours}h, retention=${cfg.retention}, offsite=${cfg.offsite.enabled ? "on" : "off"})`,
  );
}

export function handleDisable(): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "backup.enabled", false);
  saveRawConfig(raw);
  log.info("Automatic backups disabled");
}

// ---------------------------------------------------------------------------
// destinations subgroup handlers
// ---------------------------------------------------------------------------

/**
 * Load the raw destinations array, materializing the iCloud default on first
 * touch. Returns the array plus the raw config so callers can mutate and
 * re-persist.
 *
 * When `backup.offsite.destinations` is `null` in config, the runtime uses the
 * iCloud default — but that default is implicit. On first `add`/`remove`/
 * `set-encrypt`, we need to make it explicit so subsequent mutations have
 * something to mutate.
 */
function loadDestinationsForMutation(): {
  raw: Record<string, unknown>;
  destinations: BackupDestination[];
} {
  const raw = loadRawConfig();
  const current = getConfig().backup.offsite.destinations;
  const destinations = resolveOffsiteDestinations(current);
  return { raw, destinations };
}

export async function handleDestinationsList(): Promise<void> {
  const cfg = getConfig().backup;
  const destinations = resolveOffsiteDestinations(cfg.offsite.destinations);

  if (destinations.length === 0) {
    log.info("No offsite destinations configured");
    return;
  }

  const pathW = Math.max(
    4,
    ...destinations.map((d) => d.path.length),
  );
  log.info(
    "Path".padEnd(pathW) + "  " + "Encrypted",
  );
  log.info("-".repeat(pathW + 2 + 9));
  for (const d of destinations) {
    log.info(d.path.padEnd(pathW) + "  " + (d.encrypt ? "yes" : "no"));
  }
}

export interface DestinationAddOptions {
  plaintext?: boolean;
}

export function handleDestinationsAdd(
  path: string,
  opts: DestinationAddOptions,
): void {
  const { raw, destinations } = loadDestinationsForMutation();

  if (destinations.some((d) => d.path === path)) {
    log.error(
      `Destination "${path}" already exists. Run 'vellum backup destinations list' to see configured destinations.`,
    );
    process.exitCode = 1;
    return;
  }

  const next: BackupDestination[] = [
    ...destinations,
    { path, encrypt: !opts.plaintext },
  ];
  setNestedValue(raw, "backup.offsite.destinations", next);
  saveRawConfig(raw);
  log.info(
    `Added destination ${path} (${opts.plaintext ? "plaintext" : "encrypted"})`,
  );
}

export function handleDestinationsRemove(path: string): void {
  const { raw, destinations } = loadDestinationsForMutation();

  const filtered = destinations.filter((d) => d.path !== path);
  if (filtered.length === destinations.length) {
    log.error(
      `Destination "${path}" not found. Run 'vellum backup destinations list' to see configured destinations.`,
    );
    process.exitCode = 1;
    return;
  }

  setNestedValue(raw, "backup.offsite.destinations", filtered);
  saveRawConfig(raw);
  log.info(`Removed destination ${path}`);
}

export function handleDestinationsSetEncrypt(
  path: string,
  value: string,
): void {
  const normalized = value.toLowerCase();
  if (normalized !== "true" && normalized !== "false") {
    log.error(
      `Invalid encrypt value "${value}". Must be "true" or "false". ` +
        `Run 'vellum backup destinations set-encrypt --help' for usage.`,
    );
    process.exitCode = 1;
    return;
  }
  const encrypt = normalized === "true";

  const { raw, destinations } = loadDestinationsForMutation();
  const idx = destinations.findIndex((d) => d.path === path);
  if (idx === -1) {
    log.error(
      `Destination "${path}" not found. Run 'vellum backup destinations list' to see configured destinations.`,
    );
    process.exitCode = 1;
    return;
  }

  const next = destinations.map((d, i) =>
    i === idx ? { ...d, encrypt } : d,
  );
  setNestedValue(raw, "backup.offsite.destinations", next);
  saveRawConfig(raw);
  log.info(
    `Set ${path} encrypt=${encrypt ? "true" : "false"}`,
  );
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function handleStatus(): Promise<void> {
  const cfg = getConfig().backup;

  log.info(
    `Automatic backups: ${cfg.enabled ? "enabled" : "disabled"}`,
  );
  log.info(`Interval:          every ${cfg.intervalHours}h`);
  log.info(
    `Retention:         ${cfg.retention} snapshots per destination`,
  );

  // Last / next run — both gated on a valid checkpoint. The daemon records
  // `backup:last_run_at` as a unix-millis string.
  const lastRunRaw = getMemoryCheckpoint("backup:last_run_at");
  const lastRunMs = lastRunRaw ? Number.parseInt(lastRunRaw, 10) : NaN;
  const now = Date.now();
  if (!Number.isNaN(lastRunMs)) {
    const lastRunDate = new Date(lastRunMs);
    log.info(
      `Last run:          ${formatDate(lastRunDate)} (${formatDurationShort(now - lastRunMs)} ago)`,
    );
    if (cfg.enabled) {
      const intervalMs = cfg.intervalHours * 3600 * 1000;
      const nextMs = lastRunMs + intervalMs;
      const delta = nextMs - now;
      if (delta <= 0) {
        log.info(`Next run:          due now`);
      } else {
        log.info(`Next run:          in ${formatDurationShort(delta)}`);
      }
    }
  } else {
    log.info(`Last run:          never`);
    if (cfg.enabled) {
      log.info(`Next run:          on next tick`);
    }
  }

  // Local directory line — include snapshot count so users can confirm the
  // pool size matches retention.
  const localDir = getLocalBackupsDir(cfg.localDirectory);
  const localSnapshots = await listSnapshotsInDir(localDir);
  log.info(
    `Local directory:   ${localDir}  (${localSnapshots.length} snapshots)`,
  );

  // Offsite destinations — resolve the iCloud default, probe reachability
  // for each, and report snapshot counts.
  log.info(`Offsite:`);
  if (!cfg.offsite.enabled) {
    log.info(`  (disabled)`);
    return;
  }
  const destinations = resolveOffsiteDestinations(cfg.offsite.destinations);
  if (destinations.length === 0) {
    log.info(`  (no destinations configured)`);
    return;
  }
  for (const dest of destinations) {
    const reachable = await isDestinationReachable(dest.path);
    const tag = reachable ? "[OK]" : "[unreachable]";
    const enc = dest.encrypt ? "encrypted" : "plaintext";
    const snapshots = reachable
      ? await listSnapshotsInDir(dest.path)
      : [];
    const suffix = reachable
      ? ""
      : "  -- parent directory not reachable";
    log.info(
      `  ${tag} ${dest.path}  (${enc}, ${snapshots.length} snapshots)${suffix}`,
    );
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/** Print a snapshot table for a group of entries. */
function printSnapshotGroup(
  heading: string,
  entries: SnapshotEntry[],
): void {
  log.info(heading);
  if (entries.length === 0) {
    log.info("  (none)");
    return;
  }
  const tsW = 19;
  const sizeW = 10;
  const encW = 9;
  log.info(
    "  " +
      "Timestamp".padEnd(tsW) +
      "  " +
      "Size".padEnd(sizeW) +
      "  " +
      "Encrypted".padEnd(encW) +
      "  " +
      "Filename",
  );
  for (const e of entries) {
    log.info(
      "  " +
        formatDate(e.createdAt).padEnd(tsW) +
        "  " +
        formatBytes(e.sizeBytes).padEnd(sizeW) +
        "  " +
        (e.encrypted ? "yes" : "no").padEnd(encW) +
        "  " +
        e.filename,
    );
  }
}

export async function handleList(): Promise<void> {
  const cfg = getConfig().backup;
  const localDir = getLocalBackupsDir(cfg.localDirectory);
  const localSnapshots = await listSnapshotsInDir(localDir);
  printSnapshotGroup(`Local: ${localDir}`, localSnapshots);

  if (!cfg.offsite.enabled) return;
  const destinations = resolveOffsiteDestinations(cfg.offsite.destinations);
  for (const dest of destinations) {
    const entries = await listSnapshotsInDir(dest.path);
    const tag = dest.encrypt ? "encrypted" : "plaintext";
    log.info("");
    printSnapshotGroup(`Offsite: ${dest.path}  (${tag})`, entries);
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function handleCreate(): Promise<void> {
  const cfg = getConfig().backup;
  try {
    const result = await createSnapshotNow(cfg, new Date());
    log.info(`Created snapshot: ${result.local.path}`);
    log.info(`  size: ${formatBytes(result.local.sizeBytes)}`);
    log.info(`  duration: ${result.durationMs}ms`);
    if (result.offsite.length === 0) {
      log.info(`  offsite: (none)`);
    } else {
      log.info(`  offsite:`);
      for (const r of result.offsite) {
        if (r.entry) {
          log.info(
            `    ok       ${r.destination.path}  -> ${r.entry.filename}`,
          );
        } else if (r.skipped) {
          log.info(
            `    skipped  ${r.destination.path}  (${r.skipped})`,
          );
        } else {
          log.info(
            `    error    ${r.destination.path}  (${r.error ?? "unknown"})`,
          );
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("snapshot in progress")) {
      log.error(
        "Another snapshot is already running. Wait for it to finish, then retry.",
      );
    } else {
      log.error(`Snapshot failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// restore / verify helpers
// ---------------------------------------------------------------------------

/** True when a snapshot path ends in `.vbundle.enc`. */
function isEncryptedPath(path: string): boolean {
  return path.endsWith(".vbundle.enc");
}

/**
 * Load the backup key when the snapshot is encrypted. Throws a user-facing
 * error when the key file is missing or corrupt.
 */
async function loadKeyForEncryptedSnapshot(
  snapshotPath: string,
): Promise<Buffer | undefined> {
  if (!isEncryptedPath(snapshotPath)) return undefined;
  const keyPath = getBackupKeyPath();
  const key = await readBackupKey(keyPath);
  if (!key) {
    throw new Error(
      `Encrypted snapshot requires backup key at ${keyPath}, but none was found. ` +
        `The key is generated the first time automatic backup runs against an encrypted ` +
        `destination.`,
    );
  }
  return key;
}

/**
 * Prompt for y/N confirmation. Defaults to `false` on empty input, EOF, or
 * anything other than `y` / `yes` (case-insensitive).
 */
async function promptConfirm(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  path?: string;
  latest?: boolean;
  yes?: boolean;
  force?: boolean;
}

export async function handleRestore(opts: RestoreOptions): Promise<void> {
  if (!opts.path && !opts.latest) {
    log.error(
      "Must specify --path <snapshot> or --latest. " +
        "Run 'vellum backup list' to see available snapshots.",
    );
    process.exitCode = 1;
    return;
  }
  if (opts.path && opts.latest) {
    log.error(
      "Cannot combine --path and --latest. Drop one.",
    );
    process.exitCode = 1;
    return;
  }

  // Safety gate: a restore while the assistant is running is dangerous.
  // The assistant holds an open SQLite handle (referencing the old inode on
  // Unix), a cached config, and cached trust rules. Overwriting the files
  // under a running process corrupts state. Refuse unless `--force` says the
  // caller knows what they're doing.
  if (!opts.force && isDaemonRunning()) {
    log.error(
      "Assistant is running — stop it first with 'vellum sleep' before restoring " +
        "(safe restore requires an idle assistant). Pass --force to override.",
    );
    process.exitCode = 1;
    return;
  }

  let snapshotPath: string;
  if (opts.path) {
    snapshotPath = opts.path;
  } else {
    // `--latest` is explicitly scoped to local snapshots — offsite files may
    // not exist after a machine swap (per the plan), so we keep the selection
    // rule predictable.
    const cfg = getConfig().backup;
    const localDir = getLocalBackupsDir(cfg.localDirectory);
    const entries = await listSnapshotsInDir(localDir);
    if (entries.length === 0) {
      log.error(
        `No local snapshots found in ${localDir}. ` +
          `Run 'vellum backup create' to make one, or pass --path with an explicit file.`,
      );
      process.exitCode = 1;
      return;
    }
    snapshotPath = entries[0]!.path;
  }

  if (!opts.yes) {
    const confirmed = await promptConfirm(
      `Restore from ${snapshotPath}? This will overwrite workspace files. (y/N) `,
    );
    if (!confirmed) {
      log.info("Restore cancelled");
      return;
    }
  }

  let key: Buffer | undefined;
  try {
    key = await loadKeyForEncryptedSnapshot(snapshotPath);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  try {
    const workspaceDir = getWorkspaceDir();
    const hooksDir = getWorkspaceHooksDir();
    const pathResolver = new DefaultPathResolver(workspaceDir, hooksDir);

    // Close the SQLite singleton before the bundle is written. If the
    // assistant process was running in-process (tests, `--force`) the
    // singleton may still reference the old file; resetting closes the
    // handle so the restored DB file is picked up cleanly on the next
    // getDb() call.
    resetDb();

    const result = await restoreFromSnapshot(snapshotPath, {
      key,
      pathResolver,
      workspaceDir,
    });

    // Invalidate in-process caches so the restored settings.json and
    // trust.json take effect (matches the HTTP handler's recovery sequence
    // and the migration importer).
    invalidateConfigCache();
    clearTrustCache();

    log.info(`Restored from ${snapshotPath}`);
    log.info(`  source: ${result.manifest.source ?? "unknown"}`);
    log.info(`  schema_version: ${result.manifest.schema_version}`);
    log.info(`  files restored: ${result.restoredFiles}`);
  } catch (err) {
    log.error(
      `Restore failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export async function handleVerify(path: string): Promise<void> {
  let key: Buffer | undefined;
  try {
    key = await loadKeyForEncryptedSnapshot(path);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  try {
    const result = await verifySnapshot(path, { key });
    if (result.valid) {
      log.info(`OK: ${path}`);
      if (result.manifest) {
        log.info(`  schema_version: ${result.manifest.schema_version}`);
        log.info(`  source: ${result.manifest.source ?? "unknown"}`);
      }
    } else {
      log.error(`Invalid: ${path}`);
      if (result.error) log.error(`  ${result.error}`);
      process.exitCode = 1;
    }
  } catch (err) {
    log.error(
      `Verify failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command("backup")
    .description(
      "Manage automated backups, on-demand snapshots, restore, and verify",
    );

  backup.addHelpText(
    "after",
    `
Backups capture a snapshot of the assistant workspace (config, conversations,
trust rules, hooks, the SQLite database) as a .vbundle file. Credentials are
NOT included — they live in the OS keychain / CES and users re-authenticate
integrations after a restore. The automated worker runs on a configurable
interval and writes to a local pool under ~/.vellum/backups/local/, optionally
mirroring each snapshot to one or more offsite destinations (iCloud Drive by
default).

Offsite destinations can be per-destination encrypted (AES-256-GCM) or
plaintext — plaintext only makes sense when the user owns physical access to
the medium (e.g. an external SSD).

Examples:
  $ vellum backup enable --interval 6 --retention 3
  $ vellum backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ vellum backup status
  $ vellum backup list
  $ vellum backup create
  $ vellum backup restore --latest --yes
  $ vellum backup verify ~/.vellum/backups/local/backup-20260411-093000.vbundle`,
  );

  backup
    .command("enable")
    .description("Enable automated backups")
    .option(
      "--interval <hours>",
      "Hours between automated backups (1-168). Defaults to 6.",
    )
    .option(
      "--retention <n>",
      "Snapshots to retain per destination (1-100). Defaults to 3.",
    )
    .option(
      "--no-offsite",
      "Disable offsite backup (local only). Does not touch the destinations list.",
    )
    .addHelpText(
      "after",
      `
Sets backup.enabled = true in config.json. Optionally overrides intervalHours,
retention, and the offsite.enabled flag. Does NOT modify
backup.offsite.destinations — use 'vellum backup destinations add/remove' to
manage those.

Examples:
  $ vellum backup enable
  $ vellum backup enable --interval 12 --retention 14
  $ vellum backup enable --no-offsite`,
    )
    .action((opts: EnableOptions) => {
      handleEnable(opts);
    });

  backup
    .command("disable")
    .description("Disable automated backups")
    .addHelpText(
      "after",
      `
Sets backup.enabled = false in config.json. Existing snapshots are untouched;
only the automated worker stops creating new ones.

Examples:
  $ vellum backup disable`,
    )
    .action(() => {
      handleDisable();
    });

  // ---------------------------------------------------------------------------
  // destinations — subgroup
  // ---------------------------------------------------------------------------

  const destinations = backup
    .command("destinations")
    .description("Manage offsite backup destinations");

  destinations.addHelpText(
    "after",
    `
Offsite destinations are absolute paths the backup worker writes a copy of
each snapshot to after the local write succeeds. The default destination is
the iCloud Drive VellumAssistant folder, and it is used implicitly until an
explicit destinations array is configured. The first 'destinations add' or
'destinations remove' materializes the iCloud default before applying the
change, so the default is never lost on an accidental "clear all".

Each destination has an 'encrypt' flag. When true (the default), snapshots
are written as .vbundle.enc (AES-256-GCM). When false, snapshots are copied
as plaintext .vbundle — only use this for media you control physically.

Examples:
  $ vellum backup destinations list
  $ vellum backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ vellum backup destinations remove /Volumes/BackupSSD/vellum
  $ vellum backup destinations set-encrypt /Volumes/BackupSSD/vellum false`,
  );

  destinations
    .command("list")
    .description("List configured offsite destinations")
    .addHelpText(
      "after",
      `
Resolves the current destinations array (materializing the iCloud default if
no explicit array is configured) and prints a table with the path and
encryption flag per row.

Examples:
  $ vellum backup destinations list`,
    )
    .action(async () => {
      await handleDestinationsList();
    });

  destinations
    .command("add <path>")
    .description("Add an offsite backup destination")
    .option(
      "--plaintext",
      "Write snapshots as plaintext .vbundle (default is AES-256-GCM encrypted .vbundle.enc)",
    )
    .addHelpText(
      "after",
      `
Arguments:
  path   Absolute path to the destination directory. Must be on a mount the
         caller controls; the backup worker writes files inside this
         directory, not the directory itself.

If backup.offsite.destinations is currently null (the implicit iCloud default),
the iCloud default is materialized first so the new entry appends to a
2-element array rather than replacing the default.

Examples:
  $ vellum backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ vellum backup destinations add ~/Dropbox/VellumAssistant/backups`,
    )
    .action((path: string, opts: DestinationAddOptions) => {
      handleDestinationsAdd(path, opts);
    });

  destinations
    .command("remove <path>")
    .description("Remove an offsite backup destination by path")
    .addHelpText(
      "after",
      `
Arguments:
  path   Exact path match of the destination to remove. Run
         'vellum backup destinations list' to see configured paths.

Errors if no destination with the given path exists.

Examples:
  $ vellum backup destinations remove /Volumes/BackupSSD/vellum`,
    )
    .action((path: string) => {
      handleDestinationsRemove(path);
    });

  destinations
    .command("set-encrypt <path> <value>")
    .description("Toggle encryption for an existing destination")
    .addHelpText(
      "after",
      `
Arguments:
  path    Exact path match of an existing destination. Run
          'vellum backup destinations list' to see configured paths.
  value   "true" to encrypt, "false" for plaintext writes.

Errors if no destination with the given path exists. Existing snapshot files
are not modified; only future writes honour the new setting.

Examples:
  $ vellum backup destinations set-encrypt /Volumes/BackupSSD/vellum false
  $ vellum backup destinations set-encrypt /Volumes/BackupSSD/vellum true`,
    )
    .action((path: string, value: string) => {
      handleDestinationsSetEncrypt(path, value);
    });

  // ---------------------------------------------------------------------------
  // status / list / create / restore / verify
  // ---------------------------------------------------------------------------

  backup
    .command("status")
    .description("Show backup status and next-run timing")
    .addHelpText(
      "after",
      `
Reports enabled/disabled state, interval and retention, last-run and next-run
timing (from the backup:last_run_at memory checkpoint), and a per-destination
reachability probe. Unreachable destinations (parent directory missing, e.g.
iCloud Drive not enabled or external volume unplugged) are flagged
[unreachable] and skipped by the worker.

Examples:
  $ vellum backup status`,
    )
    .action(async () => {
      await handleStatus();
    });

  backup
    .command("list")
    .description("List all backup snapshots, grouped by destination")
    .addHelpText(
      "after",
      `
Prints a per-destination table of snapshots with timestamp, size, and
encryption flag. Local destination is listed first, followed by each offsite
destination. Unreachable destinations are listed with an empty snapshot set.

Examples:
  $ vellum backup list`,
    )
    .action(async () => {
      await handleList();
    });

  backup
    .command("create")
    .description("Create a backup snapshot immediately (ignores interval)")
    .addHelpText(
      "after",
      `
Triggers an on-demand snapshot. Bypasses the interval gate so it will run even
if the automated worker just ran, but still honours the concurrency mutex --
a second concurrent caller errors with "snapshot in progress". Does NOT update
the last-run checkpoint (manual snapshots should not reset the cadence).

Examples:
  $ vellum backup create`,
    )
    .action(async () => {
      await handleCreate();
    });

  backup
    .command("restore")
    .description("Restore a backup snapshot into the workspace")
    .option(
      "--path <path>",
      "Absolute path to the .vbundle or .vbundle.enc file to restore",
    )
    .option(
      "--latest",
      "Restore the newest local snapshot (offsite files are not considered)",
    )
    .option("--yes", "Skip the confirmation prompt")
    .option(
      "--force",
      "Restore even when the assistant is running (unsafe — only use if you know what you're doing)",
    )
    .addHelpText(
      "after",
      `
Restores a snapshot by writing its contents back into the workspace.
Encryption is auto-detected from the file extension; encrypted snapshots
(.vbundle.enc) require the backup key at ~/.vellum/protected/backup.key.

Prompts for confirmation unless --yes is passed.

--latest selects the newest local snapshot only. Offsite files may not exist
on a new machine after a workspace migration, so --latest refuses to dig into
them on purpose.

Safety: refuses to run while the assistant is running, because the live
SQLite handle and cached config/trust rules can corrupt the restored state.
Stop the assistant first with 'vellum sleep'. Pass --force to override (only
use this if you understand the risk).

Examples:
  $ vellum backup restore --latest --yes
  $ vellum backup restore --path ~/.vellum/backups/local/backup-20260411-093000.vbundle`,
    )
    .action(async (opts: RestoreOptions) => {
      await handleRestore(opts);
    });

  backup
    .command("verify <path>")
    .description("Verify a backup snapshot without restoring it")
    .addHelpText(
      "after",
      `
Arguments:
  path   Absolute path to a .vbundle or .vbundle.enc snapshot file.

Runs the same validation the importer would run but never touches the
workspace. Encryption is auto-detected from the file extension; encrypted
snapshots require the backup key at ~/.vellum/protected/backup.key.

Examples:
  $ vellum backup verify ~/.vellum/backups/local/backup-20260411-093000.vbundle
  $ vellum backup verify /Volumes/BackupSSD/vellum/backup-20260411-093000.vbundle.enc`,
    )
    .action(async (path: string) => {
      await handleVerify(path);
    });
}
