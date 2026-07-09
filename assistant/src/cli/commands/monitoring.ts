/**
 * `assistant monitoring` CLI command.
 *
 * Manages the resource monitor as its own OS process — separate from the
 * assistant's main event loop — so it keeps sampling memory/disk during a
 * main-thread freeze and its samples survive an OOM SIGKILL.
 *
 * Subcommands:
 *
 *   - `start`  — spawn the monitor process (or report the one already running).
 *   - `stop`   — SIGTERM the monitor process until the next daemon boot.
 *   - `status` — report the monitor process state and the most recent
 *     memory/disk sample.
 *
 * The daemon spawns the monitor at every boot; there is no config switch.
 * `stop` is a runtime-only pause for the current daemon session.
 *
 * All three are thin IPC wrappers (transport: "ipc"): the daemon owns the
 * monitor process so it is spawned as a *child of the daemon* — which is what
 * makes it appear in `assistant ps` and lets the daemon tear it down on
 * shutdown. Mirrors `assistant memory worker`.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

interface ReclaimCounters {
  pgscanDirect: number | null;
  pgstealDirect: number | null;
  workingsetRefaultFile: number | null;
}

interface CpuCounters {
  usageUsec: number | null;
  userUsec: number | null;
  systemUsec: number | null;
  nrPeriods: number | null;
  nrThrottled: number | null;
  throttledUsec: number | null;
}

interface LatestSample {
  ts: number;
  memory: {
    currentBytes: number;
    limitBytes: number | null;
    peakBytes: number | null;
    ratio: number | null;
  } | null;
  memoryStat: {
    anonBytes: number | null;
    fileBytes: number | null;
    kernelBytes: number | null;
    slabReclaimableBytes: number | null;
    slabUnreclaimableBytes: number | null;
    unevictableBytes: number | null;
    reclaimableBytes: number | null;
  } | null;
  reclaim: ReclaimCounters | null;
  cpu: CpuCounters | null;
  deltas: {
    events: {
      low: number | null;
      high: number | null;
      max: number | null;
      oom: number | null;
      oomKill: number | null;
    } | null;
    reclaim: ReclaimCounters | null;
    cpu: CpuCounters | null;
  } | null;
  disk: {
    path: string;
    usedMb: number;
    totalMb: number;
    freeMb: number;
  } | null;
  activeConversations: Array<{
    conversationId: string;
    title: string | null;
    originChannel: string | null;
    originInterface: string | null;
    processingStartedAt: number;
  }> | null;
}

interface StartResponse {
  pid: number;
  alreadyRunning: boolean;
  pidPath: string;
}

interface StopResponse {
  monitoringWasRunning: boolean;
  pid?: number;
}

interface StatusResponse {
  status: "running" | "not_running";
  pid?: number;
  dataDir: string;
  latestSample: LatestSample | null;
}

function formatMib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

export function registerMonitoringCommand(program: Command): void {
  registerCommand(program, {
    name: "monitoring",
    transport: "ipc",
    description: "Manage the resource monitor process (start/stop/status)",
    build: (monitor) => {
      monitor.addHelpText(
        "after",
        `
The resource monitor samples the container's own cgroup memory + workspace disk
in a separate OS process, off the assistant's main event loop, so it keeps
recording during a main-thread freeze and its samples survive an OOM SIGKILL.
The daemon owns the process, so it is spawned as a child of the daemon and shows
up in \`assistant ps\`.

The monitor runs by default — the daemon spawns it at every boot. \`stop\`
pauses it for the current daemon session only; it respawns on the next boot.
Samples and high-memory snapshots are written under the data directory
reported by \`status\`.

Examples:
  $ assistant monitoring start
  $ assistant monitoring status
  $ assistant monitoring stop`,
      );

      monitor
        .command("start")
        .description("Start the resource monitor process")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
          const r = await cliIpcCall<StartResponse>("monitoring_start");
          if (!r.ok) {
            return exitFromIpcResult(r);
          }
          const res = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, res);
            return;
          }
          log.info(
            res.alreadyRunning
              ? `Resource monitor is already running (PID ${res.pid})`
              : `Resource monitor started (PID ${res.pid})`,
          );
        });

      monitor
        .command("stop")
        .description(
          "Stop the resource monitor process until the next daemon boot",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
          const r = await cliIpcCall<StopResponse>("monitoring_stop");
          if (!r.ok) {
            return exitFromIpcResult(r);
          }
          const res = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, res);
            return;
          }
          if (res.monitoringWasRunning) {
            log.info(`Resource monitor stop signal sent (PID ${res.pid})`);
          } else {
            log.info("Resource monitor process was not running");
          }
          log.info("The monitor respawns on the next daemon boot");
        });

      monitor
        .command("status")
        .description("Report the monitor process state and the latest sample")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
          const r = await cliIpcCall<StatusResponse>("monitoring_status");
          if (!r.ok) {
            return exitFromIpcResult(r);
          }
          const res = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, res);
            return;
          }
          if (res.status === "running") {
            log.info(`Resource monitor process is running (PID ${res.pid})`);
          } else {
            log.info("Resource monitor process is not running");
          }
          log.info(`Data directory: ${res.dataDir}`);

          const sample = res.latestSample;
          if (!sample) {
            log.info("No samples recorded yet");
            return;
          }
          const age = Math.max(0, Math.round((Date.now() - sample.ts) / 1000));
          log.info(`Latest sample: ${age}s ago`);
          if (sample.memory) {
            const { currentBytes, limitBytes, peakBytes, ratio } =
              sample.memory;
            const pct = ratio != null ? ` (${Math.round(ratio * 100)}%)` : "";
            const limit =
              limitBytes != null ? formatMib(limitBytes) : "unknown";
            const peak = peakBytes != null ? formatMib(peakBytes) : "unknown";
            log.info(
              `  Memory: ${formatMib(currentBytes)} / ${limit}${pct}, peak ${peak}`,
            );
          }
          if (sample.memoryStat) {
            const stat = sample.memoryStat;
            const fmt = (bytes: number | null) =>
              bytes != null ? formatMib(bytes) : "unknown";
            log.info(
              `  Breakdown: anon ${fmt(stat.anonBytes)}, file ${fmt(stat.fileBytes)}, kernel ${fmt(stat.kernelBytes)}, slab ${fmt(stat.slabReclaimableBytes)} reclaimable + ${fmt(stat.slabUnreclaimableBytes)} unreclaimable`,
            );
            log.info(
              `  Split: unevictable ${fmt(stat.unevictableBytes)}, reclaimable ${fmt(stat.reclaimableBytes)}`,
            );
          }
          if (sample.reclaim) {
            const counter = (total: number | null, delta?: number | null) => {
              if (total == null) {
                return "unknown";
              }
              return delta != null ? `${total} (+${delta})` : `${total}`;
            };
            const d = sample.deltas?.reclaim;
            log.info(
              `  Reclaim: pgscan_direct ${counter(sample.reclaim.pgscanDirect, d?.pgscanDirect)}, pgsteal_direct ${counter(sample.reclaim.pgstealDirect, d?.pgstealDirect)}, workingset_refault_file ${counter(sample.reclaim.workingsetRefaultFile, d?.workingsetRefaultFile)}`,
            );
          }
          if (sample.cpu && sample.cpu.throttledUsec != null) {
            const throttleDelta = sample.deltas?.cpu?.throttledUsec;
            const throttledMs = Math.round(sample.cpu.throttledUsec / 1000);
            const deltaSuffix =
              throttleDelta != null
                ? ` (+${Math.round(throttleDelta / 1000)}ms)`
                : "";
            log.info(
              `  CPU throttling: ${sample.cpu.nrThrottled ?? "?"} periods, ${throttledMs}ms total${deltaSuffix}`,
            );
          }
          if (sample.disk) {
            log.info(
              `  Disk (${sample.disk.path}): ${sample.disk.usedMb} / ${sample.disk.totalMb} MiB used`,
            );
          }
          if (sample.activeConversations?.length) {
            const items = sample.activeConversations
              .map(
                (c) =>
                  `${c.conversationId}${c.title ? ` "${c.title}"` : ""}${c.originChannel ? ` via ${c.originChannel}` : ""}`,
              )
              .join(", ");
            log.info(`  Processing: ${items}`);
          }
        });
    },
  });
}
