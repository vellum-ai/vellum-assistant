/** Declarative help for the `assistant status` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const statusHelp: CliCommandHelp = {
  name: "status",
  description: "Show assistant version, workspace, and runtime health",
  options: [
    {
      flags: "--json",
      description: "Emit the status as machine-readable JSON",
    },
  ],
  helpText: `
Behavior:
  Reports the running assistant's version, workspace path, and memory/disk
  usage. When the assistant is unreachable, falls back to the installed CLI
  version and whether the assistant socket is present.

With --json, the same fields are emitted as a single JSON object:
  - reachable:        whether the assistant answered the health check
  - cliVersion:       the installed CLI version
  - assistantVersion: the running assistant version (null when unreachable)
  - versionStale:     true when the CLI and assistant versions differ
  - workspace:        the workspace directory
  - memory / disk:    usage in MB (null when unreachable)

Examples:
  $ assistant status
  $ assistant status --json
  $ assistant status --json | jq '.assistantVersion'`,
};
