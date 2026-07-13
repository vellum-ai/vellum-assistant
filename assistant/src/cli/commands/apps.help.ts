/** Declarative help for the `assistant apps` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const appsHelp: CliCommandHelp = {
  name: "apps",
  description: "Inspect apps and their on-disk source",
  helpText: `
Apps are mini-applications the assistant can surface. Each has a name and a
source directory holding its HTML/TSX definition, pages, and records.

Apps come from two places, distinguished by their source path:
  workspace   User-created apps under the workspace apps directory
              (~/.vellum/apps/<slug>/).
  plugin      Apps bundled by an installed plugin, each a directory under
              ~/.vellum/plugins/<name>/apps/<app>/. Stray directories without
              a plugin package.json, and disabled plugins, contribute nothing.

This surface is read-only. Workspace apps are created, edited, and deleted
through the app-builder skill and its tools (app-create, app-update,
app-delete); plugin apps are owned by their plugin.

Examples:
  $ assistant apps list
  $ assistant apps list --json`,
  subcommands: [
    {
      name: "list",
      description: "List apps with their name and source path",
      options: [
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Lists every app with its name and the absolute path to its source directory —
the path itself shows whether the app is a workspace app or bundled by a plugin
(~/.vellum/plugins/<name>/apps/...). Workspace apps are listed first, then
plugin-bundled apps; both are sorted by name.

Pass --json for machine-readable output.

Examples:
  $ assistant apps list
  $ assistant apps list --json`,
    },
  ],
};
