/**
 * `assistant schedules worker` CLI subgroup.
 *
 * Manages the schedule worker as its own OS process — separate from the
 * assistant's main event loop. Scheduled jobs run there, so expensive
 * scheduled work does not compete with user-facing traffic and keeps running
 * during a main-thread freeze.
 *
 * Subcommands:
 *
 *   - `start`  — spawn the worker process and enable
 *     `schedules.worker.enabled`, so the assistant's scheduler leaves
 *     schedule execution to the worker.
 *   - `stop`   — SIGTERM the worker process and disable
 *     `schedules.worker.enabled`, handing schedule execution back to the
 *     assistant's scheduler.
 *   - `status` — report the worker process state, the
 *     `schedules.worker.enabled` config value, and whether the assistant's
 *     in-process scheduler is currently executing schedules.
 *
 * All three are thin IPC wrappers (transport: "ipc"): the assistant owns the
 * worker process so it is spawned as a *child of the assistant* — which is
 * what makes it appear in `assistant ps` and lets the assistant tear it down
 * on shutdown. (If the CLI spawned the worker itself, the short-lived CLI
 * process would be its parent and the worker would be reparented to init.)
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

interface WorkerProcessState {
  status: "running" | "not_running";
  pid?: number;
}

interface StartResponse {
  pid: number;
  alreadyRunning: boolean;
  workerEnabled: true;
  pidPath: string;
}

interface StopResponse {
  workerWasRunning: boolean;
  pid?: number;
  workerEnabled: false;
}

interface StatusResponse {
  status: "running" | "not_running";
  pid?: number;
  workerEnabled: boolean;
  inProcessScheduler: WorkerProcessState;
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
      log.info(
        "Enabled schedules.worker.enabled; the assistant's scheduler will leave schedule execution to the worker",
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
      log.info(
        "Disabled schedules.worker.enabled; the assistant's scheduler will run schedules again",
      );
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
      log.info(`schedules.worker.enabled: ${res.workerEnabled}`);
      if (res.inProcessScheduler.status === "running") {
        log.info(
          `In-process scheduler is running (PID ${res.inProcessScheduler.pid})`,
        );
      } else {
        log.info("In-process scheduler is not running");
      }
    },
  );
}
