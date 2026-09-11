/** Declarative help for the `assistant apps` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const appsHelp: CliCommandHelp = {
  name: "apps",
  description: "List, inspect, and compile apps",
  helpText: `
Apps are mini-applications the assistant can surface. Each has a name and a
source directory holding its HTML/TSX definition, pages, and records.

Apps come from two places, distinguished by their source path:
  workspace   User-created apps under the workspace apps directory.
  plugin      Apps bundled by an installed plugin, each a directory under
              the plugin's apps/ folder. Stray directories without a plugin
              package.json, and disabled plugins, contribute nothing.

Create and delete workspace apps through the app-builder skill and its tools
(app_create, app_delete). This command lists apps, inspects whether source
has changed since the last compile, and compiles an app once you are done
editing. File edits do not compile on their own.

list and inspect read the workspace directly (the assistant does not need to
be running). refresh compiles inside the running assistant so open surfaces
pick up the new build, including plugin apps with local source changes.

Examples:
  $ assistant apps list
  $ assistant apps inspect Budget
  $ assistant apps refresh Budget`,
  subcommands: [
    {
      name: "list",
      description: "List apps with their name and source path",
      options: [
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Lists every app with its name and the absolute path to its source directory.
The path itself shows whether the app is a workspace app or bundled by a
plugin. Workspace apps are listed first, then plugin-bundled apps; both are
sorted by name.

Pass --json for machine-readable output.

Examples:
  $ assistant apps list
  $ assistant apps list --json`,
    },
    {
      name: "inspect",
      args: "<app_name>",
      description:
        "Show whether an app's source has changed since the last compile",
      options: [
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Arguments:
  app_name   App display name, directory slug, or id. Run 'assistant apps list'
             to see available apps.

Compares the on-disk source against the fingerprint recorded in dist/ at the
last successful compile. Reports clean (no changes), stale (source drifted),
never compiled, or unknown baseline (compiled before fingerprints existed).

Does not compile. Use 'assistant apps refresh <app_name>' after inspect when
source has changed.

Examples:
  $ assistant apps inspect Budget
  $ assistant apps inspect Budget --json`,
    },
    {
      name: "refresh",
      args: "<app_name>",
      description:
        "Compile an app and refresh open surfaces. Requires a running assistant",
      options: [
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Arguments:
  app_name   App display name, directory slug, or id. Run 'assistant apps list'
             to see available apps.

Compiles src/ into dist/ inside the running assistant, then refreshes any
open surfaces and published deployments. Call this once after a batch of
edits, not after every file write. Workspace and plugin apps are both
accepted so local plugin source changes can be compiled without waiting
for the plugin watcher.

The assistant must be running.

Examples:
  $ assistant apps refresh Budget
  $ assistant apps refresh Budget --json`,
    },
  ],
};
