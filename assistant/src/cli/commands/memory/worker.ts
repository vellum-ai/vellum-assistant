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
 * All three run directly in the CLI process (transport: "local") — no IPC
 * round-trip to the daemon. The daemon's worker supervisor re-reads
 * `memory.worker.enabled` each poll and stands its synchronous runner down (or
 * resumes it) accordingly, so flipping the flag here switches the running
 * daemon's mode without a restart.
 */

import type { Command } from "commander";

import {
  getConfigReadOnly,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
} from "../../../config/loader.js";
import {
  probeMemoryWorker,
  probeSyncRunner,
  spawnMemoryWorkerProcess,
} from "../../../memory/worker-control.js";
import { getMemoryWorkerPidPath } from "../../../util/platform.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

/**
 * Persist `memory.worker.enabled` to the on-disk config via the shared
 * raw-config helpers, so only this leaf changes (schema defaults are not baked
 * into the file). The assistant picks the change up on its next config read.
 */
function setWorkerEnabled(enabled: boolean): void {
  const raw = loadRawConfig();
  setNestedValue(raw, "memory.worker.enabled", enabled);
  saveRawConfig(raw);
}

// ---------------------------------------------------------------------------
// `start`
// ---------------------------------------------------------------------------

async function startWorker(
  opts: { json?: boolean },
  cmd: Command,
): Promise<void> {
  let result: { pid: number; alreadyRunning: boolean };
  try {
    // Terminate the child if it times out: this path leaves
    // `memory.worker.enabled` off on failure, so a worker that came up late
    // would drain the queue alongside the daemon's synchronous runner.
    result = await spawnMemoryWorkerProcess({ terminateOnTimeout: true });
  } catch (err) {
    // Spawn failed — leave `memory.worker.enabled` untouched so the daemon's
    // synchronous runner keeps draining the queue rather than standing down
    // for a worker that never came up.
    const msg = err instanceof Error ? err.message : String(err);
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg });
    } else {
      log.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  // The worker process is up (freshly spawned or already running). Enable the
  // flag so the daemon's supervisor stands its synchronous runner down (and so
  // the daemon spawns the worker again on the next restart).
  setWorkerEnabled(true);

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, {
      ok: true,
      pid: result.pid,
      alreadyRunning: result.alreadyRunning,
      pidPath: getMemoryWorkerPidPath(),
      workerEnabled: true,
    });
  } else {
    log.info(
      result.alreadyRunning
        ? `Memory worker is already running (PID ${result.pid})`
        : `Memory worker started (PID ${result.pid})`,
    );
    log.info(
      "Enabled memory.worker.enabled; the synchronous in-process runner will stand down",
    );
  }
}

// ---------------------------------------------------------------------------
// `stop`
// ---------------------------------------------------------------------------

function stopWorker(opts: { json?: boolean }, cmd: Command): void {
  // Persist the preference first: `stop` means "hand the queue back to the
  // synchronous in-process runner." Disabling the flag makes the daemon's
  // supervisor resume processing in-process on its next poll and lines the next
  // daemon restart up with synchronous mode; the SIGTERM below then stops the
  // now-redundant worker process.
  setWorkerEnabled(false);

  const current = probeMemoryWorker();
  if (current.status !== "running" || current.pid == null) {
    // No worker process to signal — flipping the flag alone restores
    // synchronous mode, so this is success, not an error.
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, {
        ok: true,
        workerWasRunning: false,
        workerEnabled: false,
      });
    } else {
      log.info(
        "Memory worker process was not running; disabled memory.worker.enabled (synchronous runner active)",
      );
    }
    return;
  }

  const pid = current.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg, pid, workerEnabled: false });
    } else {
      log.error(`Failed to stop memory worker (PID ${pid}): ${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, pid, workerEnabled: false });
  } else {
    log.info(`Memory worker stop signal sent (PID ${pid})`);
    log.info(
      "Disabled memory.worker.enabled; the synchronous in-process runner will take over",
    );
  }
}

// ---------------------------------------------------------------------------
// `status`
// ---------------------------------------------------------------------------

function statusWorker(opts: { json?: boolean }, cmd: Command): void {
  const worker = probeMemoryWorker();
  const syncRunner = probeSyncRunner();
  const workerEnabled = getConfigReadOnly().memory.worker.enabled;

  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ...worker, workerEnabled, syncRunner });
  } else {
    if (worker.status === "running") {
      log.info(`Memory worker process is running (PID ${worker.pid})`);
    } else {
      log.info("Memory worker process is not running");
    }
    log.info(`memory.worker.enabled: ${workerEnabled}`);
    if (syncRunner.status === "running") {
      log.info(
        `Synchronous in-process runner is running (PID ${syncRunner.pid})`,
      );
    } else {
      log.info("Synchronous in-process runner is not running");
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
separate OS process so they do not block the assistant's main event loop.

\`start\` enables memory.worker.enabled and \`stop\` disables it, so the
assistant's synchronous in-process runner stands down (start) or takes back over
(stop) without a restart.

Examples:
  $ assistant memory worker start
  $ assistant memory worker status
  $ assistant memory worker stop`,
      );

      worker
        .command("start")
        .description(
          "Start the memory worker process and enable memory.worker.enabled",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action(async (opts: { json?: boolean }, cmd: Command) => {
          await startWorker(opts, cmd);
        });

      worker
        .command("stop")
        .description(
          "Stop the memory worker process and disable memory.worker.enabled",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action((opts: { json?: boolean }, cmd: Command) => {
          stopWorker(opts, cmd);
        });

      worker
        .command("status")
        .description(
          "Report worker process state, memory.worker.enabled, and the synchronous runner",
        )
        .option("--json", "Emit raw JSON instead of a formatted summary")
        .action((opts: { json?: boolean }, cmd: Command) => {
          statusWorker(opts, cmd);
        });
    },
  });
}
