/** Declarative help for the `assistant clients` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const clientsHelp: CliCommandHelp = {
  name: "clients",
  description: "Discover and manage connected clients",
  helpText: `
Clients are the applications currently connected to the assistant —
macOS desktop, iOS, web, Chrome extension, or CLI. Each client has a
set of capabilities (e.g. host_bash, host_file) that determine which
tools the assistant can route through it.

Examples:
  $ assistant clients list                             List all connected clients
  $ assistant clients list --json                      Machine-readable JSON output
  $ assistant clients list --capability host_bash      Show only clients that can run host commands
  $ assistant clients disconnect <clientId>            Force-disconnect a client`,
  subcommands: [
    {
      name: "list",
      description: "List all currently connected clients",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
        {
          flags: "--capability <name>",
          description:
            "Filter to clients supporting this capability (e.g. host_bash, host_file, host_cu, host_browser, host_app_control)",
        },
      ],
      helpText: `
Options:
  --json                Output as compact JSON instead of a table.
  --capability <name>   Only show clients that support the named capability.
                        Valid values: host_bash, host_file, host_cu, host_browser, host_app_control.

The table shows each client's ID, interface type, capabilities,
connection timestamps, and host environment (when available).
Clients are sorted by most recently connected first.

Examples:
  $ assistant clients list
  $ assistant clients list --capability host_bash
  $ assistant clients list --json | jq '.clients[0].capabilities'`,
    },
    {
      name: "disconnect",
      args: "<clientId>",
      description: "Force-disconnect a client by its ID",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Arguments:
clientId   The UUID of the client to disconnect (from \`clients list\`).

Force-disposes all hub subscribers for the given client, closing their
SSE streams. The client will observe a broken connection and may
reconnect automatically depending on its implementation.

Examples:
$ assistant clients disconnect a1a30bde-6679-406c-bc32-d5a0d2a7a99e
$ assistant clients disconnect a1a30bde-6679-406c-bc32-d5a0d2a7a99e --json`,
    },
  ],
};
