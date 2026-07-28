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
import { applyCommandHelp } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeOutput } from "../output.js";
import { psHelp } from "./ps.help.js";

interface ProcessEntry {
  name: string;
  status: "running" | "not_running" | "unreachable";
  /** `workspace`, or `plugin:<name>` when spawned from a plugin. */
  origin: "workspace" | `plugin:${string}`;
  children?: ProcessEntry[];
  info?: string;
}

interface PsResponse {
  processes: ProcessEntry[];
}

/**
 * One flattened output row. Column 1 (`name`) carries the hierarchy
 * indentation; the remaining columns are aligned to a common start index
 * across all rows regardless of tree depth.
 */
interface Row {
  name: string;
  origin: string;
  info: string;
}

/** Flatten the tree into rows, indenting each name to reflect tree depth. */
function flattenEntries(entry: ProcessEntry, depth: number, rows: Row[]): void {
  rows.push({
    name: "  ".repeat(depth) + entry.name,
    origin: entry.origin,
    info: entry.info ?? "",
  });
  for (const child of entry.children ?? []) {
    flattenEntries(child, depth + 1, rows);
  }
}

/**
 * Render the flattened rows as aligned columns. Column 1 keeps its per-row
 * indentation for hierarchy; columns 2..N are padded to a shared width so
 * every row's column starts at the same index. Status is not shown — the
 * daemon only ever reports live processes, so a `[running]` label carries no
 * information.
 */
function renderRows(rows: Row[]): void {
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const originWidth = Math.max(...rows.map((r) => r.origin.length));
  for (const r of rows) {
    const line = `${r.name.padEnd(nameWidth)}  ${r.origin.padEnd(
      originWidth,
    )}  ${r.info}`;
    log.info(line.trimEnd());
  }
}

export function registerPsCommand(program: Command): void {
  registerCommand(program, {
    name: psHelp.name,
    transport: "ipc",
    description: psHelp.description,
    build: (ps) => {
      applyCommandHelp(ps, psHelp);

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

        const rows: Row[] = [];
        for (const entry of processes) {
          flattenEntries(entry, 0, rows);
        }

        log.info("");
        renderRows(rows);
        log.info("");
      });
    },
  });
}
