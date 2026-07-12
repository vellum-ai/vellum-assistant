/**
 * Declarative help for the `assistant auth` command.
 *
 * Plain data (no action handlers, imports only the help contract type) so the
 * memory capability indexer can read it without pulling in the daemon/IPC action
 * graph. The handlers live in `auth.ts`, which applies this via `applyCommandHelp`
 * and attaches them.
 */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const authHelp: CliCommandHelp = {
  name: "auth",
  description: "Manage platform authentication and identity",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
The auth namespace manages the assistant's authentication state with the
Vellum platform. It provides commands to inspect identity and connection
status, helping diagnose configuration issues.

Examples:
  $ assistant auth info
  $ assistant auth info --json`,
  subcommands: [
    {
      name: "info",
      description: "Show platform identity and authentication status",
      helpText: `
Fields:
  platformUrl         The Vellum platform base URL this assistant connects to
  assistantId         This assistant's platform UUID
  organizationId      The organization this assistant belongs to (from PLATFORM_ORGANIZATION_ID)
  userId              The user who owns this assistant (from PLATFORM_USER_ID)
  authenticated       Whether all prerequisites for platform authentication are met
                      (platform URL and assistant API key both present)

When not authenticated, a message field provides guidance on next steps.

Examples:
  $ assistant auth info
  $ assistant auth info --json`,
    },
  ],
};
