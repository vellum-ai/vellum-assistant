/**
 * `assistant routes worker` CLI subgroup.
 *
 * The route host runs user-defined `/x/*` handlers as its own OS process — a
 * child of the assistant, spawned on demand — so a handler that blocks does not
 * stall the assistant's main event loop and can be reclaimed with a hard kill.
 *
 * Subcommands (thin IPC wrappers; the assistant owns the process so it is
 * spawned as a child of the assistant and appears in `assistant ps`):
 *
 *   - `start`  — spawn the route host process if it is not already running.
 *   - `stop`   — SIGTERM the route host process (the next request respawns it).
 *   - `status` — report the route host process state.
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

export function registerRoutesWorkerCommand(routes: Command): void {
  const worker = subcommand(routes, "worker");

  subcommand(worker, "start").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StartResponse>("routes_worker_start");
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
          ? `Route host is already running (PID ${res.pid})`
          : `Route host started (PID ${res.pid})`,
      );
    },
  );

  subcommand(worker, "stop").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StopResponse>("routes_worker_stop");
      if (!r.ok) {
        return exitFromIpcResult(r);
      }
      const res = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, res);
        return;
      }
      if (res.workerWasRunning) {
        log.info(`Route host stop signal sent (PID ${res.pid})`);
      } else {
        log.info("Route host process was not running");
      }
      log.info("The route host respawns on the next request");
    },
  );

  subcommand(worker, "status").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StatusResponse>("routes_worker_status");
      if (!r.ok) {
        return exitFromIpcResult(r);
      }
      const res = r.result!;

      if (shouldOutputJson(cmd)) {
        writeOutput(cmd, res);
        return;
      }
      if (res.status === "running") {
        log.info(`Route host process is running (PID ${res.pid})`);
      } else {
        log.info("Route host process is not running");
      }
    },
  );
}
