/**
 * Declarative help for the `assistant audit` command.
 *
 * Plain data (no action handlers, imports only the help contract type) so the
 * memory capability indexer can read it without pulling in the daemon/IPC action
 * graph. The handler lives in `audit.ts`, which applies this via
 * `applyCommandHelp` and attaches it.
 */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const auditHelp: CliCommandHelp = {
  name: "audit",
  description: "Show recent tool invocations",
  options: [
    {
      flags: "-l, --limit <n>",
      description: "Number of entries to show",
      defaultValue: "20",
    },
    { flags: "--json", description: "Output raw JSON" },
  ],
  helpText: `
Reads from the tool invocation audit log via the daemon. Each row
represents one tool call the assistant made, including what was invoked,
how the approval system classified it, and how long it took.

Table columns:
  Timestamp   When the tool was invoked (UTC, YYYY-MM-DD HH:MM:SS)
  Tool        Tool name (e.g. bash, read_file, write_file, browser)
  Input       Truncated summary of the tool input (command, path, etc.)
  Decision    Approval decision: allow, deny, or ask
  Risk        Risk classification: none, low, medium, high
  Duration    Wall-clock execution time (e.g. 120ms, 1.3s)

Examples:
  $ assistant audit
  $ assistant audit --limit 50
  $ assistant audit --json`,
};
