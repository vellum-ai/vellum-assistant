/**
 * `assistant schedules worker` CLI subgroup.
 *
 * The schedule worker runs scheduled jobs as its own OS process — a child of
 * the assistant spawned at startup — so expensive scheduled work does not
 * compete with user-facing traffic and keeps running during a main-thread
 * freeze. `status` is a thin IPC wrapper (the assistant owns the process, so it
 * reports the process it manages) that reports the worker's liveness.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

interface StatusResponse {
  status: "running" | "not_running";
  pid?: number;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSchedulesWorkerCommand(schedules: Command): void {
  const worker = subcommand(schedules, "worker");

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
