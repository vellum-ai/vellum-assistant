/** Declarative help for the `assistant apps` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const appsHelp: CliCommandHelp = {
  name: "apps",
  description: "Inspect user-defined apps and their on-disk source",
  helpText: `
Apps are user-defined mini-applications stored under the workspace apps
directory (~/.vellum/apps/<slug>/). Each app has a human-readable name and a
source directory holding its HTML/TSX definition, pages, and records.

This surface is read-only. Apps are created, edited, and deleted through the
app-builder skill and its tools (app-create, app-update, app-delete) — there is
no CLI create/update/delete verb by design.

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
Lists every app with its name and the absolute path to its source directory.
The source path is the app's directory under the workspace apps directory; it
holds index.html (single-file apps) or the TSX source tree (multi-file apps).

Pass --json for the full record, including the app ID, format version, and
last-updated time.

Examples:
  $ assistant apps list
  $ assistant apps list --json`,
    },
  ],
};
