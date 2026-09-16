/** Declarative help for the `assistant bash` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const bashHelp: CliCommandHelp = {
  name: "bash",
  args: "<command>",
  description:
    "Execute a shell command with the same sanitized environment as the bash tool",
  options: [
    {
      flags: "-t, --timeout <ms>",
      description: "Timeout in milliseconds for command execution",
      defaultValue: "30000",
    },
  ],
  helpText: `
Spawns the command with the same sanitized environment, working directory,
and platform shell the bash tool uses for tool-call subprocesses. Vault
bearers such as CES_SERVICE_TOKEN are stripped; CES_LOCAL_SOCKET and workspace
paths are forwarded. The command does not go through the assistant HTTP or IPC
API, and does not require a running assistant process.

Arguments:
  command   The shell command string to execute (e.g. "echo hello", "ls -la").
            Runs via the same platform shell invocation the bash tool uses.

Examples:
  $ assistant bash "echo hello"
  $ assistant bash "which node"
  $ assistant bash "env | grep PATH" --timeout 10000
  $ assistant bash "assistant oauth request --provider outlook --json https://graph.microsoft.com/v1.0/me"`,
};
