/**
 * `assistant schedules worker` CLI subgroup.
 *
 * Manages the schedule worker as its own OS process — separate from the
 * assistant's main event loop. Script-mode schedules (shell commands, no LLM)
 * run there, so expensive scheduled scripts do not compete with user-facing
 * traffic and keep running during a main-thread freeze. Non-script schedule
 * modes always run in the assistant, whose agent pipeline they depend on.
 *
 * Subcommands:
 *
 *   - `start`  — spawn the worker process and enable
 *     `schedules.worker.enabled`, so the assistant's scheduler leaves
 *     script-mode schedules to the worker.
 *   - `stop`   — SIGTERM the worker process and disable
 *     `schedules.worker.enabled`, handing script-mode schedules back to the
 *     assistant's scheduler.
 *   - `status` — report the worker process state, the
 *     `schedules.worker.enabled` config value, and whether the assistant's
 *     in-process scheduler is currently the script-mode runner.
 *
 * All three are thin IPC wrappers (transport: "ipc"): the assistant owns the
 * worker process so it is spawned as a *child of the assistant* — which is
 * what makes it appear in `assistant ps` and lets the assistant tear it down
 * on shutdown. (If the CLI spawned the worker itself, the short-lived CLI
 * process would be its parent and the worker would be reparented to init.)
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
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
  inProcessScriptRunner: WorkerProcessState;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSchedulesWorkerCommand(schedules: Command): void {
  registerCommand(schedules, {
    name: "worker",
    transport: "ipc",
    description: "Manage the schedule worker process (start/stop/status)",
    build: (worker) => {
      worker.addHelpText(
        "after",
        `
The schedule worker runs script-mode schedules in a separate OS process so
expensive scheduled scripts execute off the assistant's main event loop. The
assistant owns the process, so it is spawned as a child of the assistant and
shows up in \`assistant ps\`. Non-script schedules (execute/notify/wake/
workflow) always run in the assistant itself.

\`start\` enables schedules.worker.enabled and \`stop\` disables it, so the
assistant's scheduler hands script-mode schedules to the worker (start) or
takes them back (stop) without a restart.

Examples:
  $ assistant schedules worker start
  $ assistant schedules worker status
  $ assistant schedules worker stop`,
      );

      worker
        .command("start")
        .description(
          "Start the schedule worker process and enable schedules.worker.enabled",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
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
            "Enabled schedules.worker.enabled; the assistant's scheduler will leave script-mode schedules to the worker",
          );
        });

      worker
        .command("stop")
        .description(
          "Stop the schedule worker process and disable schedules.worker.enabled",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
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
            "Disabled schedules.worker.enabled; the assistant's scheduler will run script-mode schedules again",
          );
        });

      worker
        .command("status")
        .description(
          "Report worker process state, schedules.worker.enabled, and the in-process script runner",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (_opts: { json?: boolean }, cmd: Command) => {
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
          if (res.inProcessScriptRunner.status === "running") {
            log.info(
              `In-process script runner is running (PID ${res.inProcessScriptRunner.pid})`,
            );
          } else {
            log.info("In-process script runner is not running");
          }
        });
    },
  });
}
