/**
 * `assistant memory worker` CLI subgroup.
 *
 * Manages the memory jobs worker as its own OS process — separate from the
 * daemon's main event loop. This prevents long-running embedding jobs from
 * blocking user-facing HTTP traffic.
 *
 * Subcommands:
 *
 *   - `start`  — spawn the worker process and enable `memory.worker.enabled`,
 *     standing the daemon's synchronous in-process runner down.
 *   - `stop`   — SIGTERM the worker process and disable `memory.worker.enabled`,
 *     handing the queue back to the synchronous in-process runner.
 *   - `status` — report the worker process state, the `memory.worker.enabled`
 *     config value, and whether the synchronous in-process runner is going.
 *
 * All three are thin IPC wrappers: the daemon owns the
 * worker process so it is spawned as a *child of the daemon* — which is what
 * makes it appear in `assistant ps` and lets the daemon tear it down on
 * shutdown. (If the CLI spawned the worker itself, the short-lived CLI process
 * would be its parent and the worker would be reparented to init.)
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

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
  syncRunner: WorkerProcessState;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMemoryWorkerCommand(memory: Command): void {
  const worker = subcommand(memory, "worker");

  subcommand(worker, "start").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StartResponse>("memory_worker_start");
      if (!r.ok) return exitFromIpcResult(r);
      const res = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, res);
        return;
      }
      log.info(
        res.alreadyRunning
          ? `Memory worker is already running (PID ${res.pid})`
          : `Memory worker started (PID ${res.pid})`,
      );
      log.info(
        "Enabled memory.worker.enabled; the synchronous in-process runner will stand down",
      );
    },
  );

  subcommand(worker, "stop").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StopResponse>("memory_worker_stop");
      if (!r.ok) return exitFromIpcResult(r);
      const res = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, res);
        return;
      }
      if (res.workerWasRunning) {
        log.info(`Memory worker stop signal sent (PID ${res.pid})`);
      } else {
        log.info("Memory worker process was not running");
      }
      log.info(
        "Disabled memory.worker.enabled; the synchronous in-process runner will take over",
      );
    },
  );

  subcommand(worker, "status").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StatusResponse>("memory_worker_status");
      if (!r.ok) return exitFromIpcResult(r);
      const res = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, res);
        return;
      }
      if (res.status === "running") {
        log.info(`Memory worker process is running (PID ${res.pid})`);
      } else {
        log.info("Memory worker process is not running");
      }
      log.info(`memory.worker.enabled: ${res.workerEnabled}`);
      if (res.syncRunner.status === "running") {
        log.info(
          `Synchronous in-process runner is running (PID ${res.syncRunner.pid})`,
        );
      } else {
        log.info("Synchronous in-process runner is not running");
      }
    },
  );
}
