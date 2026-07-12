/**
 * `assistant memory worker` CLI subgroup.
 *
 * The memory jobs worker processes embedding, consolidation, and cleanup jobs
 * as its own OS process — a child of the daemon spawned at startup — so
 * long-running jobs don't block user-facing HTTP traffic. It is spun up by
 * default; these commands manage the process lifecycle on demand.
 *
 * Subcommands (thin IPC wrappers; the daemon owns the process so it is spawned
 * as a child of the daemon and appears in `assistant ps`):
 *
 *   - `start`  — spawn the worker process if it is not already running.
 *   - `stop`   — SIGTERM the worker process.
 *   - `status` — report the worker process state and the embedding backend.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

interface StartResponse {
  pid: number;
  alreadyRunning: boolean;
  pidPath: string;
}

interface StopResponse {
  workerWasRunning: boolean;
  pid?: number;
}

interface EmbeddingStatus {
  enabled: boolean;
  degraded: boolean;
  provider: "local" | "openai" | "gemini" | "ollama" | null;
  model: string | null;
  reason: string | null;
}

interface StatusResponse {
  status: "running" | "not_running";
  pid?: number;
  embedding: EmbeddingStatus;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMemoryWorkerCommand(memory: Command): void {
  const worker = subcommand(memory, "worker");

  subcommand(worker, "start").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StartResponse>("memory_worker_start");
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
          ? `Memory worker is already running (PID ${res.pid})`
          : `Memory worker started (PID ${res.pid})`,
      );
    },
  );

  subcommand(worker, "stop").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StopResponse>("memory_worker_stop");
      if (!r.ok) {
        return exitFromIpcResult(r);
      }
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
    },
  );

  subcommand(worker, "status").action(
    async (_opts: { json?: boolean }, cmd: Command) => {
      const r = await cliIpcCall<StatusResponse>("memory_worker_status");
      if (!r.ok) {
        return exitFromIpcResult(r);
      }
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
      if (res.embedding.degraded) {
        log.info(
          `Embedding backend degraded${res.embedding.reason ? `: ${res.embedding.reason}` : ""}`,
        );
      }
    },
  );
}
