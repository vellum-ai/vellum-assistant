/**
 * `assistant backup` — manage automated backup configuration and list snapshots.
 *
 * Thin IPC wrapper: each subcommand forwards its request to the daemon via
 * cliIpcCall and never imports daemon-internal modules.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
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

/** Format an ISO date string as `YYYY-MM-DD HH:MM UTC`. */
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
// Command wiring
// ---------------------------------------------------------------------------

export function registerBackupCommand(program: Command): void {
  registerCommand(program, {
    name: "backup",
    transport: "ipc",
    description: "Manage automated backup configuration and list snapshots",
    build: (backup) => {
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
  $ assistant backup enable --interval 6 --retention 3
  $ assistant backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ assistant backup status
  $ assistant backup list`,
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
backup.offsite.destinations — use 'assistant backup destinations add/remove' to
manage those.

Examples:
  $ assistant backup enable
  $ assistant backup enable --interval 12 --retention 14
  $ assistant backup enable --no-offsite`,
        )
        .action(
          async (
            opts: { interval?: string; retention?: string; offsite?: boolean },
            cmd: Command,
          ) => {
            const r = await cliIpcCall("backup_enable", {
              body: {
                ...(opts.interval !== undefined && {
                  intervalHours: Number.parseInt(opts.interval, 10),
                }),
                ...(opts.retention !== undefined && {
                  retention: Number.parseInt(opts.retention, 10),
                }),
                ...(opts.offsite === false && { offsiteEnabled: false }),
              },
            });
            if (!r.ok)
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            const cfg = r.result as {
              intervalHours: number;
              retention: number;
              offsite: { enabled: boolean };
            };
            log.info(
              `Automatic backups enabled (interval=${cfg.intervalHours}h, retention=${cfg.retention}, offsite=${cfg.offsite.enabled ? "on" : "off"})`,
            );
          },
        );

      backup
        .command("disable")
        .description("Disable automated backups")
        .addHelpText(
          "after",
          `
Sets backup.enabled = false in config.json. Existing snapshots are untouched;
only the automated worker stops creating new ones.

Examples:
  $ assistant backup disable`,
        )
        .action(async (_opts: unknown, cmd: Command) => {
          const r = await cliIpcCall("backup_disable");
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          log.info("Automatic backups disabled");
        });

      // -----------------------------------------------------------------------
      // destinations — subgroup
      // -----------------------------------------------------------------------

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
  $ assistant backup destinations list
  $ assistant backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ assistant backup destinations remove /Volumes/BackupSSD/vellum
  $ assistant backup destinations set-encrypt /Volumes/BackupSSD/vellum false`,
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
  $ assistant backup destinations list`,
        )
        .action(async (_opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            destinations: Array<{ path: string; encrypt: boolean }>;
          }>("backup_destinations_list");
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          const { destinations: dests } = r.result!;
          if (dests.length === 0) {
            log.info("No offsite destinations configured");
            return;
          }
          const pathW = Math.max(4, ...dests.map((d) => d.path.length));
          log.info("Path".padEnd(pathW) + "  " + "Encrypted");
          log.info("-".repeat(pathW + 2 + 9));
          for (const d of dests) {
            log.info(d.path.padEnd(pathW) + "  " + (d.encrypt ? "yes" : "no"));
          }
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
  $ assistant backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ assistant backup destinations add ~/Dropbox/VellumAssistant/backups`,
        )
        .action(
          async (path: string, opts: { plaintext?: boolean }, cmd: Command) => {
            const r = await cliIpcCall("backup_destinations_add", {
              body: {
                path,
                encrypt: !opts.plaintext,
              },
            });
            if (!r.ok)
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            log.info(
              `Added destination ${path} (${opts.plaintext ? "plaintext" : "encrypted"})`,
            );
          },
        );

      destinations
        .command("remove <path>")
        .description("Remove an offsite backup destination by path")
        .addHelpText(
          "after",
          `
Arguments:
  path   Exact path match of the destination to remove. Run
         'assistant backup destinations list' to see configured paths.

Errors if no destination with the given path exists.

Examples:
  $ assistant backup destinations remove /Volumes/BackupSSD/vellum`,
        )
        .action(async (path: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall("backup_destinations_remove", { body: { path } });
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          log.info(`Removed destination ${path}`);
        });

      destinations
        .command("set-encrypt <path> <value>")
        .description("Toggle encryption for an existing destination")
        .addHelpText(
          "after",
          `
Arguments:
  path    Exact path match of an existing destination. Run
          'assistant backup destinations list' to see configured paths.
  value   "true" to encrypt, "false" for plaintext writes.

Errors if no destination with the given path exists. Existing snapshot files
are not modified; only future writes honour the new setting.

Examples:
  $ assistant backup destinations set-encrypt /Volumes/BackupSSD/vellum false
  $ assistant backup destinations set-encrypt /Volumes/BackupSSD/vellum true`,
        )
        .action(
          async (path: string, value: string, _opts: unknown, cmd: Command) => {
            const normalized = value.toLowerCase();
            if (normalized !== "true" && normalized !== "false") {
              log.error(
                `Invalid encrypt value "${value}". Must be "true" or "false". ` +
                  `Run 'assistant backup destinations set-encrypt --help' for usage.`,
              );
              process.exitCode = 1;
              return;
            }
            const r = await cliIpcCall("backup_destinations_set_encrypt", {
              body: {
                path,
                encrypt: normalized === "true",
              },
            });
            if (!r.ok)
              return exitFromIpcResult(
                { ok: false, error: r.error, statusCode: r.statusCode },
                cmd,
              );
            log.info(`Set ${path} encrypt=${normalized}`);
          },
        );

      // -----------------------------------------------------------------------
      // status / list
      // -----------------------------------------------------------------------

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
  $ assistant backup status`,
        )
        .action(async (_opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            enabled: boolean;
            intervalHours: number;
            retention: number;
            lastRunAt: string | null;
            nextRunAt: string | null;
            localDir: string;
            localSnapshotCount: number;
            offsiteEnabled: boolean;
            offsite: Array<{
              path: string;
              encrypt: boolean;
              reachable: boolean;
              snapshotCount: number;
            }>;
          }>("backup_status");
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          const s = r.result!;
          const now = Date.now();

          log.info(`Automatic backups: ${s.enabled ? "enabled" : "disabled"}`);
          log.info(`Interval:          every ${s.intervalHours}h`);
          log.info(
            `Retention:         ${s.retention} snapshots per destination`,
          );

          if (s.lastRunAt) {
            const lastRunMs = new Date(s.lastRunAt).getTime();
            log.info(
              `Last run:          ${formatDate(new Date(s.lastRunAt))} (${formatDurationShort(now - lastRunMs)} ago)`,
            );
            if (s.enabled && s.nextRunAt) {
              const nextMs = new Date(s.nextRunAt).getTime();
              const delta = nextMs - now;
              if (delta <= 0) {
                log.info(`Next run:          due now`);
              } else {
                log.info(`Next run:          in ${formatDurationShort(delta)}`);
              }
            }
          } else {
            log.info(`Last run:          never`);
            if (s.enabled) {
              log.info(`Next run:          on next tick`);
            }
          }

          log.info(
            `Local directory:   ${s.localDir}  (${s.localSnapshotCount} snapshots)`,
          );

          log.info(
            `Offsite:           ${s.offsiteEnabled ? "enabled" : "disabled"}`,
          );
          if (!s.offsiteEnabled) {
            return;
          }
          if (s.offsite.length === 0) {
            log.info(`  (no destinations configured)`);
            return;
          }
          for (const dest of s.offsite) {
            const tag = dest.reachable ? "[OK]" : "[unreachable]";
            const enc = dest.encrypt ? "encrypted" : "plaintext";
            const suffix = dest.reachable
              ? ""
              : "  -- parent directory not reachable";
            log.info(
              `  ${tag} ${dest.path}  (${enc}, ${dest.snapshotCount} snapshots)${suffix}`,
            );
          }
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
  $ assistant backup list`,
        )
        .action(async (_opts: unknown, cmd: Command) => {
          const r = await cliIpcCall<{
            local: Array<{
              filename: string;
              createdAt: string;
              sizeBytes: number;
              encrypted: boolean;
            }>;
            offsite: Array<{
              destination: { path: string; encrypt: boolean };
              snapshots: Array<{
                filename: string;
                createdAt: string;
                sizeBytes: number;
                encrypted: boolean;
              }>;
              reachable: boolean;
            }>;
            offsiteEnabled: boolean;
            nextRunAt: string | null;
          }>("backups_list");
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          const data = r.result!;

          printSnapshotGroup(`Local:`, data.local);

          if (!data.offsiteEnabled) return;
          for (const dest of data.offsite) {
            const tag = dest.destination.encrypt ? "encrypted" : "plaintext";
            log.info("");
            printSnapshotGroup(
              `Offsite: ${dest.destination.path}  (${tag})`,
              dest.snapshots,
            );
          }
        });
    },
  });
}

// ---------------------------------------------------------------------------
// Snapshot table printer
// ---------------------------------------------------------------------------

function printSnapshotGroup(
  heading: string,
  entries: Array<{
    filename: string;
    createdAt: string;
    sizeBytes: number;
    encrypted: boolean;
  }>,
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
        formatDate(new Date(e.createdAt)).padEnd(tsW) +
        "  " +
        formatBytes(e.sizeBytes).padEnd(sizeW) +
        "  " +
        (e.encrypted ? "yes" : "no").padEnd(encW) +
        "  " +
        e.filename,
    );
  }
}
