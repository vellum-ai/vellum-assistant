/**
 * `vellum backup` — manage automated backup configuration and list snapshots.
 *
 * All subcommands run in-process (they do not call the daemon HTTP port).
 * Config mutations go through `loadRawConfig` / `setNestedValue` / `saveRawConfig`
 * so the on-disk `config.json` is the single source of truth and the daemon's
 * config cache is invalidated via `saveRawConfig`.
 */

import { stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { Command } from "commander";

import {
  listSnapshotsInDir,
  type SnapshotEntry,
} from "../../backup/list-snapshots.js";
import {
  getLocalBackupsDir,
  resolveOffsiteDestinations,
} from "../../backup/paths.js";
import {
  getConfig,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../config/loader.js";
import type { BackupDestination } from "../../config/schema.js";
import { getMemoryCheckpoint } from "../../memory/checkpoints.js";
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
 * reachability check in the backup worker — if the parent is missing (e.g.
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

  const pathW = Math.max(4, ...destinations.map((d) => d.path.length));
  log.info("Path".padEnd(pathW) + "  " + "Encrypted");
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

  const next = destinations.map((d, i) => (i === idx ? { ...d, encrypt } : d));
  setNestedValue(raw, "backup.offsite.destinations", next);
  saveRawConfig(raw);
  log.info(`Set ${path} encrypt=${encrypt ? "true" : "false"}`);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function handleStatus(): Promise<void> {
  const cfg = getConfig().backup;

  log.info(`Automatic backups: ${cfg.enabled ? "enabled" : "disabled"}`);
  log.info(`Interval:          every ${cfg.intervalHours}h`);
  log.info(`Retention:         ${cfg.retention} snapshots per destination`);

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
    const snapshots = reachable ? await listSnapshotsInDir(dest.path) : [];
    const suffix = reachable ? "" : "  -- parent directory not reachable";
    log.info(
      `  ${tag} ${dest.path}  (${enc}, ${snapshots.length} snapshots)${suffix}`,
    );
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/** Print a snapshot table for a group of entries. */
function printSnapshotGroup(heading: string, entries: SnapshotEntry[]): void {
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
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command("backup")
    .description(
      "Manage automated backup configuration and list snapshots",
    );

  backup.addHelpText(
    "after",
    `
Backups capture a snapshot of the assistant workspace (config, conversations,
trust rules, hooks, the SQLite database) as a .vbundle file. Credentials are
NOT included — they live in the OS keychain / CES and users re-authenticate
integrations after a restore (via the gateway). The automated worker runs on a configurable
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
  $ vellum backup list`,
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
  // status / list
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

}
