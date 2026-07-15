/** Declarative help for the `assistant plugins` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";
import {
  DEFAULT_PIN_HISTORY_LIMIT,
  DEFAULT_PLUGIN_REF,
  DEFAULT_PLUGIN_UPGRADE_STRATEGY,
  PLUGIN_UPGRADE_STRATEGIES,
} from "../lib/plugin-constants.js";

export const pluginsHelp: CliCommandHelp = {
  name: "plugins",
  description:
    "List, search, install, and manage external plugins (`list` shows what is installed, `search` queries the marketplace)",
  helpText: `
Examples:
  $ assistant plugins install example
  $ assistant plugins install example --force
  $ assistant plugins install https://github.com/owner/repo
  $ assistant plugins install https://github.com/owner/repo/tree/main/sub/path --name my-plugin
  $ assistant plugins install example --ref my-feature-branch
  $ assistant plugins versions example
  $ assistant plugins versions example --json
  $ assistant plugins install example --pin <sha> --force
  $ assistant plugins list
  $ assistant plugins list --json
  $ assistant plugins list --all
  $ assistant plugins list --all --json
  $ assistant plugins inspect example
  $ assistant plugins inspect example --json
  $ assistant plugins diff example
  $ assistant plugins diff example --json
  $ assistant plugins upgrade example
  $ assistant plugins upgrade example --dry-run
  $ assistant plugins upgrade example --strategy ours
  $ assistant plugins upgrade example --strategy theirs
  $ assistant plugins upgrade example --strategy assistant
  $ assistant plugins search example
  $ assistant plugins search "^example"
  $ assistant plugins search example --json
  $ assistant plugins uninstall example
  $ assistant plugins enable example
  $ assistant plugins disable example`,
  subcommands: [
    {
      name: "install",
      args: "<name-or-url>",
      description:
        "Install a plugin by name from the Vellum platform (content is served as a verified tarball from the plugin's pinned commit), or directly from a GitHub URL (untrusted)",
      options: [
        { flags: "--force", description: "Overwrite an existing install" },
        {
          flags: "--ref <ref>",
          description: `Marketplace manifest revision to read the pin from (default: ${DEFAULT_PLUGIN_REF}). Marketplace installs only — for a GitHub URL, put the ref in the URL (.../tree/<ref>/...)`,
        },
        {
          flags: "--pin <sha>",
          description:
            "Install a specific reviewed marketplace pin (full commit SHA); run `plugins versions <name>` to list them. Marketplace installs only",
        },
        {
          flags: "--allow-unreviewed",
          description:
            "With --pin, install a SHA that is not in the reviewed marketplace history (advanced; the curated adapter may not match). Marketplace installs only",
        },
        {
          flags: "--name <name>",
          description:
            "Install directory name for a GitHub-URL install (default: derived from the repo or sub-path leaf). Ignored for marketplace installs",
        },
      ],
      helpText: `
A GitHub URL (anything containing a slash) installs directly from that repo,
bypassing the marketplace whitelist. Such a plugin is UNTRUSTED — it has not
been reviewed and its hooks/tools run with full assistant access — so the
install prints a warning. Use it for a plugin still under development that is
not in the catalog yet. The ref comes from the URL's /tree/<ref>/ segment, or
defaults to the repository's default branch.

Examples:
  $ assistant plugins install https://github.com/owner/repo
  $ assistant plugins install https://github.com/owner/repo/tree/my-branch/path/to/plugin
  $ assistant plugins install owner/repo --name my-plugin --force`,
    },
    {
      name: "versions",
      args: "<name>",
      description:
        "List the recent reviewed marketplace pins for a plugin, newest first. Install an older one with `plugins install <name> --pin <sha>`",
      options: [
        {
          flags: "--json",
          description: "Emit machine-readable JSON instead of a table",
        },
        {
          flags: "--limit <n>",
          description: `Maximum number of pins to show (default: ${DEFAULT_PIN_HISTORY_LIMIT})`,
        },
      ],
    },
    {
      name: "list",
      description: "List plugins installed in your workspace.",
      options: [
        {
          flags: "--json",
          description: "Emit machine-readable JSON instead of a table",
        },
        {
          flags: "--all",
          description:
            "Include first-party default plugins and disabled plugins in the listing",
        },
      ],
    },
    {
      name: "inspect",
      args: "<name>",
      description:
        "Show a plugin's local install metadata, the marketplace pin, whether an update is available, and the surfaces (skills, hooks, tools) it contributes",
      options: [
        {
          flags: "--json",
          description: "Emit machine-readable JSON instead of a summary",
        },
      ],
    },
    {
      name: "diff",
      args: "<name>",
      description:
        "Show a unified diff of local edits to an installed plugin against the commit it was installed at",
      options: [
        {
          flags: "--json",
          description:
            "Emit the machine-readable diff result as JSON (files: { path, status, diff, binary, reconstructed }[]) instead of a unified diff",
        },
      ],
      helpText: `
Arguments:
  name   Install name (kebab-case directory under the workspace plugins dir);
         run 'assistant plugins list' to see installed names.

The baseline is the exact commit the plugin was installed at (recorded in its
install-meta.json), re-materialized through the install pipeline — so an
install-time adapter transform never reads as a local change. To compare
against the marketplace's current pin instead, use 'plugins upgrade --dry-run'.

Examples:
  $ assistant plugins diff example
  $ assistant plugins diff example --json`,
    },
    {
      name: "search",
      args: "<query>",
      description:
        "Search the plugins/marketplace.json catalog for plugin names matching <query> (case-insensitive regex)",
      options: [
        {
          flags: "--json",
          description: "Emit machine-readable JSON instead of a table",
        },
      ],
    },
    {
      name: "publish",
      description:
        "Validate and submit the plugin in the current directory to the Vellum marketplace catalog",
      options: [
        {
          flags: "--print",
          description:
            "Print the entry JSON without submitting to the platform",
        },
        {
          flags: "--path <dir>",
          description: "Validate a plugin at the given path instead of CWD",
        },
        { flags: "--force", description: "Skip the confirmation prompt" },
        {
          flags: "--json",
          description: "Emit machine-readable JSON instead of human output",
        },
        {
          flags: "--category <cat>",
          description: "Set the category, skipping the interactive prompt",
        },
      ],
      helpText: `

Validates the plugin in the current directory (or --path), resolves the
git commit SHA and GitHub remote, and submits the entry to the Vellum
platform API. The platform creates a pull request against
vellum-ai/vellum-assistant adding the plugin to the marketplace catalog.

Requires a connected Vellum platform account (run \`assistant platform connect\`).
Use --print to validate and print the entry without submitting.

Examples:
$ assistant plugins publish
$ assistant plugins publish --print
$ assistant plugins publish --path ./my-plugin --category productivity
$ assistant plugins publish --json`,
    },
    {
      name: "uninstall",
      args: "<name>",
      description: "Remove a plugin from <workspaceDir>/plugins/<name>/",
      options: [
        { flags: "--force", description: "Skip the confirmation prompt" },
      ],
    },
    {
      name: "disable",
      args: "<name>",
      description:
        "Disable a plugin by creating a .disabled sentinel file. Works for both user-installed and default plugins. Takes effect immediately in a running assistant.",
    },
    {
      name: "enable",
      args: "<name>",
      description:
        "Re-enable a disabled plugin by removing the .disabled sentinel file. Takes effect immediately.",
    },
    {
      name: "upgrade",
      args: "<name>",
      description:
        "Upgrade an installed plugin to its source's current revision (the marketplace pin, or — for a GitHub-URL install — whatever its recorded branch/tag/ref now resolves to)",
      options: [
        {
          flags: "--dry-run",
          description: "Show what would change without modifying the install",
        },
        {
          flags: "--strategy <strategy>",
          description: `How to reconcile local edits with the target: ${PLUGIN_UPGRADE_STRATEGIES.join(", ")} (default: ${DEFAULT_PLUGIN_UPGRADE_STRATEGY})`,
        },
        {
          flags: "--json",
          description: "Emit machine-readable JSON instead of a summary",
        },
      ],
      helpText: `
A marketplace plugin upgrades to the curated pin. A plugin installed directly
from a GitHub URL (untrusted) upgrades against its recorded source: it re-fetches
whatever its recorded ref resolves to now — a pinned commit SHA is immutable (a
no-op), while a branch/tag/HEAD advances as upstream does — and re-materializes
it verbatim, with no curated adapter overlay.

Examples:
  $ assistant plugins upgrade example
  $ assistant plugins upgrade example --dry-run
  $ assistant plugins upgrade example --strategy ours`,
    },
  ],
};
