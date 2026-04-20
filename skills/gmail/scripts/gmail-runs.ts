#!/usr/bin/env bun

/**
 * Gmail operation run management.
 * Subcommands:
 *   list    — List recent runs with status summary
 *   inspect — Show detailed log entries for a specific run
 *   prune   — Delete op logs older than 30 days
 */

import { parseArgs, optionalArg, printError, ok } from "./lib/common.js";
import {
  listRuns,
  summarizeRun,
  readLog,
  pruneOldRuns,
  runExists,
} from "./lib/op-log.js";

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function listCmd(args: Record<string, string | boolean>) {
  const limit = parseInt(optionalArg(args, "limit") ?? "20", 10);
  const runIds = listRuns().slice(0, limit);

  if (runIds.length === 0) {
    ok({ runs: [], note: "No operation logs found" });
    return;
  }

  const runs = runIds
    .map((id) => summarizeRun(id))
    .filter((s) => s !== null);

  ok({ runs });
}

function inspectCmd(args: Record<string, string | boolean>) {
  const runId = optionalArg(args, "run-id");
  if (!runId) {
    printError("Missing required argument: --run-id");
    return;
  }

  if (!runExists(runId)) {
    printError(`Run not found: ${runId}`);
    return;
  }

  const entries = readLog(runId);
  const summary = summarizeRun(runId);

  ok({ summary, entries });
}

function pruneCmd() {
  const pruned = pruneOldRuns();
  ok({ pruned, note: `Deleted ${pruned} log(s) older than 30 days` });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const subcommand = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (subcommand) {
    case "list":
      listCmd(args);
      break;
    case "inspect":
      inspectCmd(args);
      break;
    case "prune":
      pruneCmd();
      break;
    default:
      printError(
        `Unknown subcommand: "${subcommand ?? "(none)"}". Use "list", "inspect", or "prune".`,
      );
  }
}

if (import.meta.main) {
  main();
}
