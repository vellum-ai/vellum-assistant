/**
 * `assistant memory worker` CLI subgroup.
 *
 * Manages the memory jobs worker as its own OS process — separate from the
 * daemon's main event loop. This prevents long-running embedding jobs from
 * blocking user-facing HTTP traffic.
 *
 * Subcommands:
 *
 *   - `start`  — spawn the worker process (detached, background).
 *   - `stop`   — send SIGTERM to the running worker process.
 *   - `status` — report whether the worker process is running.
 *
 * All three run directly in the CLI process (transport: "local") — no IPC
 * round-trip to the daemon.
 */

import type { Command } from "commander";

import {
  probeMemoryWorker,
  spawnMemoryWorkerProcess,
} from "../../../memory/worker-control.js";
import { getMemoryWorkerPidPath } from "../../../util/platform.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// `start`
// ---------------------------------------------------------------------------

async function startWorker(
  opts: { json?: boolean },
  cmd: Command,
): Promise<void> {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    result = await spawnMemoryWorkerProcess();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg });
    } else {
      log.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  if (result.alreadyRunning) {
    const msg = `Memory worker is already running (PID ${result.pid})`;
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg, pid: result.pid });
    } else {
      log.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, {
      ok: true,
      pid: result.pid,
      pidPath: getMemoryWorkerPidPath(),
    });
  } else {
    log.info(`Memory worker started (PID ${result.pid})`);
  }
}

// ---------------------------------------------------------------------------
// `stop`
// ---------------------------------------------------------------------------

function stopWorker(opts: { json?: boolean }, cmd: Command): void {
  const current = probeMemoryWorker();
  if (current.status !== "running" || current.pid == null) {
    const msg = "Memory worker is not running";
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg });
    } else {
      log.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  const pid = current.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg, pid });
    } else {
      log.error(`Failed to stop memory worker (PID ${pid}): ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, pid });
  } else {
    log.info(`Memory worker stop signal sent (PID ${pid})`);
  }
}

// ---------------------------------------------------------------------------
// `status`
// ---------------------------------------------------------------------------

function statusWorker(opts: { json?: boolean }, cmd: Command): void {
  const result = probeMemoryWorker();
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, result);
  } else {
    if (result.status === "running") {
      log.info(`Memory worker is running (PID ${result.pid})`);
    } else {
      log.info("Memory worker is not running");
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMemoryWorkerCommand(memory: Command): void {
  registerCommand(memory, {
    name: "worker",
    transport: "local",
    description: "Manage the memory jobs worker process (start/stop/status)",
    build: (worker) => {
      worker.addHelpText(
        "after",
        `
The memory worker processes embedding, consolidation, and cleanup jobs in a
separate OS process so they do not block the daemon's main event loop.

Examples:
  $ assistant memory worker start
  $ assistant memory worker status
  $ assistant memory worker stop`,
      );

      worker
        .command("start")
        .description("Start the memory worker as a background process")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (opts: { json?: boolean }, cmd: Command) => {
          await startWorker(opts, cmd);
        });

      worker
        .command("stop")
        .description("Stop the running memory worker process")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action((opts: { json?: boolean }, cmd: Command) => {
          stopWorker(opts, cmd);
        });

      worker
        .command("status")
        .description("Check whether the memory worker process is running")
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action((opts: { json?: boolean }, cmd: Command) => {
          statusWorker(opts, cmd);
        });
    },
  });
}
