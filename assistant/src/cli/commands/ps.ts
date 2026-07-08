/**
 * CLI command: `assistant ps`
 *
 * Thin IPC wrapper over the daemon's `ps` route. Renders the daemon's own
 * process tree (the assistant runtime and its supervised subsystems —
 * qdrant, embed-worker) to the console. The route owns the live probing;
 * the CLI just forwards the request and formats the response.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";

interface ProcessEntry {
  name: string;
  status: "running" | "not_running" | "unreachable";
  children?: ProcessEntry[];
  info?: string;
}

interface PsResponse {
  processes: ProcessEntry[];
}

const STATUS_LABEL: Record<ProcessEntry["status"], string> = {
  running: "running",
  not_running: "not running",
  unreachable: "unreachable",
};

/** Render one entry plus its children, indented to reflect tree depth. */
function renderEntry(entry: ProcessEntry, depth: number): void {
  const indent = "  ".repeat(depth);
  const status = STATUS_LABEL[entry.status] ?? entry.status;
  const info = entry.info ? ` — ${entry.info}` : "";
  log.info(`${indent}${entry.name}  [${status}]${info}`);
  for (const child of entry.children ?? []) {
    renderEntry(child, depth + 1);
  }
}

export function registerPsCommand(program: Command): void {
  registerCommand(program, {
    name: "ps",
    transport: "ipc",
    description: "Show the assistant daemon's live process tree",
    build: (ps) => {
      ps.option("--json", "Machine-readable JSON output").addHelpText(
        "after",
        `
Walks the daemon's OS process tree and reports every descendant process
parented to the assistant runtime — qdrant, the embed worker, the memory
worker (when the daemon owns it), MCP servers, and any other live children.
The tree is built from the native process table (/proc on Linux, ps on
macOS), so it reflects what is actually running, not a fixed subsystem list.

Each node shows its PID; every listed process is live by definition.

Examples:
  $ assistant ps
  $ assistant ps --json`,
      );

      ps.action(async (_opts, cmd: Command) => {
        const r = await cliIpcCall<PsResponse>("ps");
        if (!r.ok) return exitFromIpcResult(r);

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, r.result);
          return;
        }

        const processes = r.result?.processes ?? [];
        if (processes.length === 0) {
          log.info("No processes reported.");
          return;
        }

        log.info("");
        for (const entry of processes) {
          renderEntry(entry, 0);
        }
        log.info("");
      });
    },
  });
}
