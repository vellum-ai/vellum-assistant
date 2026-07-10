/**
 * `assistant backup` — manage automated backup configuration and list snapshots.
 *
 * Thin IPC wrapper: each subcommand forwards its request to the daemon via
 * cliIpcCall. The command's help structure lives in `backup.help.ts`
 * (import-safe for the memory capability indexer); this module applies it and
 * attaches the action handlers.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { backupHelp } from "./backup.help.js";

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
    name: backupHelp.name,
    transport: "ipc",
    description: backupHelp.description,
    build: (backup) => {
      applyCommandHelp(backup, backupHelp);

      // ── enable ───────────────────────────────────────────────────────
      subcommand(backup, "enable").action(
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

      // ── disable ──────────────────────────────────────────────────────
      subcommand(backup, "disable").action(
        async (_opts: unknown, cmd: Command) => {
          const r = await cliIpcCall("backup_disable");
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          log.info("Automatic backups disabled");
        },
      );

      // ── destinations ─────────────────────────────────────────────────
      const destinations = subcommand(backup, "destinations");

      subcommand(destinations, "list").action(
        async (_opts: unknown, cmd: Command) => {
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
        },
      );

      subcommand(destinations, "add").action(
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

      subcommand(destinations, "remove").action(
        async (path: string, _opts: unknown, cmd: Command) => {
          const r = await cliIpcCall("backup_destinations_remove", {
            body: { path },
          });
          if (!r.ok)
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          log.info(`Removed destination ${path}`);
        },
      );

      subcommand(destinations, "set-encrypt").action(
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

      // ── status ───────────────────────────────────────────────────────
      subcommand(backup, "status").action(
        async (_opts: unknown, cmd: Command) => {
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
        },
      );

      // ── list ─────────────────────────────────────────────────────────
      subcommand(backup, "list").action(
        async (_opts: unknown, cmd: Command) => {
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
        },
      );
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
