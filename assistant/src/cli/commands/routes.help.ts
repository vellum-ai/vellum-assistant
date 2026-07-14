/** Declarative help for the `assistant routes` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const routesHelp: CliCommandHelp = {
  name: "routes",
  description:
    "Manage user-defined authenticated HTTP route handlers under /x/*",
  helpText: `
User-defined routes let you expose custom HTTP endpoints by dropping handler
files into /workspace/routes/ (reachable at /x/<path>) or into a plugin's
/workspace/plugins/<name>/routes/ (reachable in that plugin's namespace at
/x/plugins/<name>/<path>). Each file exports named HTTP method functions
(GET, POST, etc.).

These routes require edge authentication — they are intended for
assistant-internal or user-facing endpoints, not for unauthenticated provider
webhooks.

Routes are managed by creating and deleting files — no add/remove commands
needed.

Examples:
  $ assistant routes list
  $ assistant routes list --json
  $ assistant routes inspect my-dashboard-api/submit
  $ assistant routes inspect plugins/my-plugin/status`,
  subcommands: [
    {
      name: "list",
      description: "List all user-defined route handlers and their public URLs",
      options: [
        {
          flags: "--json",
          description: "Machine-readable JSON output",
        },
      ],
      helpText: `
Scans /workspace/routes/ and each enabled plugin's /workspace/plugins/<name>/routes/
for handler files (.ts, .js) and displays the route path, exported HTTP
methods, optional description, and file location.

Examples:
  $ assistant routes list
  $ assistant routes list --json`,
    },
    {
      name: "inspect",
      args: "<path>",
      description: "Show details of a specific user-defined route handler",
      options: [
        {
          flags: "--json",
          description: "Machine-readable JSON output",
        },
      ],
      helpText: `
Arguments:
  path   Route path relative to /x/ (e.g. "my-dashboard-api/submit" or
         "plugins/my-plugin/status"). The /x/ prefix is optional, so a path
         copied straight from 'routes list' works too.

Loads the handler file and displays exported methods, description, file path,
public URL, file size, and last modified time.

Examples:
  $ assistant routes inspect my-dashboard-api/submit
  $ assistant routes inspect plugins/my-plugin/status
  $ assistant routes inspect items --json`,
    },
  ],
};
