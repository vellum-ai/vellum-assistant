/**
 * `assistant resource-monitor` CLI command.
 *
 * Manages the resource monitor as its own OS process — separate from the
 * assistant's main event loop — so it keeps sampling memory/disk during a
 * main-thread freeze and its samples survive an OOM SIGKILL.
 *
 * Subcommands:
 *
 *   - `start`  — spawn the monitor process and enable `resourceMonitor.enabled`.
 *   - `stop`   — SIGTERM the monitor process and disable `resourceMonitor.enabled`.
 *   - `status` — report the monitor process state, `resourceMonitor.enabled`,
 *     and the most recent memory/disk sample.
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

interface LatestSample {
  ts: number;
  memory: {
    currentBytes: number;
    limitBytes: number | null;
    peakBytes: number | null;
    ratio: number | null;
  } | null;
  disk: {
    path: string;
    usedMb: number;
    totalMb: number;
    freeMb: number;
  } | null;
}

interface StartResponse {
  pid: number;
  alreadyRunning: boolean;
  monitorEnabled: true;
  pidPath: string;
}

interface StopResponse {
  monitorWasRunning: boolean;
  pid?: number;
  monitorEnabled: false;
}

interface StatusResponse {
  status: "running" | "not_running";
  pid?: number;
  monitorEnabled: boolean;
  dataDir: string;
  latestSample: LatestSample | null;
}

function formatMib(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

export function registerResourceMonitorCommand(program: Command): void {
  registerCommand(program, {
    name: "resource-monitor",
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

\`start\` enables resourceMonitor.enabled (so it is respawned on the next boot)
and \`stop\` disables it. Samples and high-memory snapshots are written under the
data directory reported by \`status\`.

Examples:
  $ assistant resource-monitor start
  $ assistant resource-monitor status
  $ assistant resource-monitor stop`,
      );

      monitor
        .command("start")
        .description(
          "Start the resource monitor process and enable resourceMonitor.enabled",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
          const r = await cliIpcCall<StartResponse>("resource_monitor_start");
          if (!r.ok) return exitFromIpcResult(r);
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
          log.info(
            "Enabled resourceMonitor.enabled; it will be respawned on the next assistant start",
          );
        });

      monitor
        .command("stop")
        .description(
          "Stop the resource monitor process and disable resourceMonitor.enabled",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
          const r = await cliIpcCall<StopResponse>("resource_monitor_stop");
          if (!r.ok) return exitFromIpcResult(r);
          const res = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, res);
            return;
          }
          if (res.monitorWasRunning) {
            log.info(`Resource monitor stop signal sent (PID ${res.pid})`);
          } else {
            log.info("Resource monitor process was not running");
          }
          log.info("Disabled resourceMonitor.enabled");
        });

      monitor
        .command("status")
        .description(
          "Report the monitor process state, resourceMonitor.enabled, and the latest sample",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
          const r = await cliIpcCall<StatusResponse>("resource_monitor_status");
          if (!r.ok) return exitFromIpcResult(r);
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
          log.info(`resourceMonitor.enabled: ${res.monitorEnabled}`);
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
          if (sample.disk) {
            log.info(
              `  Disk (${sample.disk.path}): ${sample.disk.usedMb} / ${sample.disk.totalMb} MiB used`,
            );
          }
        });
    },
  });
}
