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

import { existsSync, readFileSync, unlinkSync } from "node:fs";

import type { Command } from "commander";

import { getMemoryWorkerPidPath } from "../../../util/platform.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

interface PidStatus {
  status: "running" | "not_running";
  pid?: number;
}

function probeWorker(): PidStatus {
  const pidPath = getMemoryWorkerPidPath();
  if (!existsSync(pidPath)) return { status: "not_running" };

  const raw = readFileSync(pidPath, "utf-8").trim();
  const pid = parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { status: "not_running" };

  try {
    process.kill(pid, 0);
    return { status: "running", pid };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ESRCH"
    ) {
      // Stale PID file — clean it up.
      try {
        unlinkSync(pidPath);
      } catch {
        // best-effort
      }
      return { status: "not_running" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `start`
// ---------------------------------------------------------------------------

async function startWorker(
  opts: { json?: boolean },
  cmd: Command,
): Promise<void> {
  const current = probeWorker();
  if (current.status === "running") {
    const msg = `Memory worker is already running (PID ${current.pid})`;
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg, pid: current.pid });
    } else {
      log.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  const pidPath = getMemoryWorkerPidPath();
  const entry = new URL("../../../memory/worker-process.ts", import.meta.url);

  // Spawn detached so the worker survives the CLI process exiting.
  const child = Bun.spawn({
    cmd: ["bun", "run", entry.pathname],
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });

  // Unreference so the CLI process doesn't wait for the child.
  child.unref();

  // Wait briefly for the PID file to appear (the worker writes it on startup).
  let pidWritten = false;
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(100);
    if (existsSync(pidPath)) {
      pidWritten = true;
      break;
    }
  }

  if (!pidWritten) {
    const msg =
      "Memory worker was spawned but PID file did not appear within 1s";
    if (shouldOutputJson(cmd)) {
      writeOutput(cmd, { ok: false, error: msg });
    } else {
      log.error(msg);
    }
    process.exitCode = 1;
    return;
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  if (shouldOutputJson(cmd)) {
    writeOutput(cmd, { ok: true, pid, pidPath });
  } else {
    log.info(`Memory worker started (PID ${pid})`);
  }
}

// ---------------------------------------------------------------------------
// `stop`
// ---------------------------------------------------------------------------

function stopWorker(opts: { json?: boolean }, cmd: Command): void {
  const current = probeWorker();
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
  const result = probeWorker();
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
