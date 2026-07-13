/**
 * `assistant schedules worker` CLI subgroup.
 *
 * The schedule worker runs scheduled jobs as its own OS process — a child of
 * the assistant spawned at startup — so expensive scheduled work does not
 * compete with user-facing traffic and keeps running during a main-thread
 * freeze. It is spun up by default; these commands manage the process lifecycle
 * on demand.
 *
 * Subcommands (thin IPC wrappers; the assistant owns the process so it is
 * spawned as a child of the assistant and appears in `assistant ps`):
 *
 *   - `start`  — spawn the worker process if it is not already running.
 *   - `stop`   — SIGTERM the worker process.
 *   - `status` — report the worker process state.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

interface StartResponse {
  pid: number;
  alreadyRunning: boolean;
  pidPath: string;
}

interface StopResponse {
  workerWasRunning: boolean;
  pid?: number;
}

interface StatusResponse {
  status: "running" | "not_running";
  pid?: number;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSchedulesWorkerCommand(schedules: Command): void {
  const worker = subcommand(schedules, "worker");

  subcommand(worker, "start").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StartResponse>("schedules_worker_start");
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
          ? `Schedule worker is already running (PID ${res.pid})`
          : `Schedule worker started (PID ${res.pid})`,
      );
    },
  );

  subcommand(worker, "stop").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StopResponse>("schedules_worker_stop");
      if (!r.ok) {
        return exitFromIpcResult(r);
      }
      const res = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, res);
        return;
      }
      if (res.workerWasRunning) {
        log.info(`Schedule worker stop signal sent (PID ${res.pid})`);
      } else {
        log.info("Schedule worker process was not running");
      }
    },
  );

  subcommand(worker, "status").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StatusResponse>("schedules_worker_status");
      if (!r.ok) {
        return exitFromIpcResult(r);
      }
      const res = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, res);
        return;
      }
      if (res.status === "running") {
        log.info(`Schedule worker process is running (PID ${res.pid})`);
      } else {
        log.info("Schedule worker process is not running");
      }
    },
  );
}
