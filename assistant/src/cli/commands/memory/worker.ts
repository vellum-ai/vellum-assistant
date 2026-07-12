/**
 * `assistant memory worker` CLI subgroup.
 *
 * The memory jobs worker processes embedding, consolidation, and cleanup jobs
 * as its own OS process — a child of the daemon spawned at startup — so
 * long-running jobs don't block user-facing HTTP traffic. `status` is a thin
 * IPC wrapper (the daemon owns the process, so it reports the process it
 * manages) that reports the worker's liveness and the embedding-backend status.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

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
