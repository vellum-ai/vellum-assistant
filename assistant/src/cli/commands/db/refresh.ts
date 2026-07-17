/**
 * `assistant db refresh` — close and reopen all SQLite singleton connections
 * across every process in the assistant.
 *
 * Runs locally (no IPC). Does two things:
 *
 * 1. Finds every PID holding a file descriptor on any of the four assistant
 *    SQLite DB files (main, logs, memory, telemetry) via `lsof -t`.
 * 2. Sends SIGUSR1 to each PID. Each long-running process (daemon, schedule
 *    worker, memory worker, monitoring worker) has a SIGUSR1 handler that
 *    calls `resetDb()` to drop its cached SQLite singletons. The next DB
 *    access lazily reopens against the current file on disk.
 *
 * This is the recovery path when a database file has been replaced on disk
 * while the assistant is running (e.g. a corrupt `assistant-logs.db` was
 * deleted and recreated) and a process's cached file handle is now stale.
 */

import { execFileSync } from "node:child_process";

import type { Command } from "commander";

import { getLogsDbPath } from "../../../util/logs-db-path.js";
import { getMemoryDbPath } from "../../../util/memory-db-path.js";
import { getDbPath } from "../../../util/platform.js";
import { getTelemetryDbPath } from "../../../util/telemetry-db-path.js";
import { dim, green, red } from "../../lib/cli-colors.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

interface SignalResult {
  pid: number;
  signaled: boolean;
  error?: string;
}

/**
 * Find PIDs (other than ourselves) holding file descriptors on the given
 * paths. Uses `lsof -t` which prints raw PIDs, one per line.
 */
function findHoldingPids(paths: string[]): number[] {
  const pidSet = new Set<number>();
  const myPid = process.pid;

  for (const path of paths) {
    try {
      const output = execFileSync("lsof", ["-t", path], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      for (const line of output.trim().split("\n")) {
        const pid = parseInt(line, 10);
        if (pid > 0 && pid !== myPid) {
          pidSet.add(pid);
        }
      }
    } catch {
      // lsof not available, or file not held by anyone.
    }
  }

  return [...pidSet];
}

/**
 * Send SIGUSR1 to a PID. Returns true if delivered, false if the process
 * exited before we could signal it.
 */
function signalPid(pid: number): SignalResult {
  try {
    process.kill(pid, "SIGUSR1");
    return { pid, signaled: true };
  } catch (err) {
    return {
      pid,
      signaled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerDbRefresh(parent: Command): void {
  subcommand(parent, "refresh").action(function (this: Command) {
    const dbPaths = [
      getDbPath(),
      getLogsDbPath(),
      getMemoryDbPath(),
      getTelemetryDbPath(),
    ];

    const holdingPids = findHoldingPids(dbPaths);
    const signaled = holdingPids.map(signalPid);

    if (shouldOutputJson(this)) {
      writeOutput(this, {
        ok: signaled.every((s) => s.signaled),
        signaled,
      });
      return;
    }

    if (signaled.length === 0) {
      process.stdout.write(
        "No other processes holding database files. Nothing to refresh.\n",
      );
      return;
    }

    for (const sig of signaled) {
      const status = sig.signaled ? green("signaled") : red("failed");
      let line = `  PID ${String(sig.pid).padEnd(8)} ${status}`;
      if (sig.error) {
        line += `  ${sig.error}`;
      }
      process.stdout.write(line + "\n");
    }

    const allOk = signaled.every((s) => s.signaled);
    if (allOk) {
      process.stdout.write(
        `\n${dim("All processes signaled. Connections will reopen on next access.")}\n`,
      );
    } else {
      process.stdout.write(
        "\nSome processes could not be signaled. They may need a restart.\n",
      );
      process.exit(1);
    }
  });
}
