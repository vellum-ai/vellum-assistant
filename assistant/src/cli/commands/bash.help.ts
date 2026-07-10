/**
 * Declarative help for the `assistant bash` command.
 *
 * Plain data (no action handlers, imports only the help contract type) so the
 * memory capability indexer can read it without pulling in the daemon/IPC action
 * graph. The handler lives in `bash.ts`, which applies this via
 * `applyCommandHelp` and attaches it.
 */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const bashHelp: CliCommandHelp = {
  name: "bash",
  args: "<command>",
  description:
    "Execute a shell command through the assistant process for debugging",
  options: [
    {
      flags: "-t, --timeout <ms>",
      description: "Timeout in milliseconds for command execution",
      defaultValue: "30000",
    },
  ],
  helpText: `
Sends a shell command to the running assistant for execution via the IPC
socket. The assistant spawns the command in its own process environment and
returns stdout, stderr, and the exit code.

This is a developer debugging tool for inspecting how the assistant invokes and
observes shell commands. The command runs with the assistant's environment, working
directory, and process context — not the caller's shell.

Requires the assistant to be running with VELLUM_DEBUG=1. When debug mode is off
(the default), the assistant returns an error immediately.

Arguments:
  command   The shell command string to execute (e.g. "echo hello", "ls -la").
            Runs in bash via \`bash -c\` in the assistant's process environment.

Examples:
  $ assistant bash "echo hello"
  $ assistant bash "which node"
  $ assistant bash "env | grep PATH" --timeout 10000
  $ assistant bash "ls -la"`,
};
