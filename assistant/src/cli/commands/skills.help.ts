/** Declarative help for the `assistant skills` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const skillsHelp: CliCommandHelp = {
  name: "skills",
  description: "Browse and install skills from the Vellum catalog",
  helpText: `
Manage skills from the Vellum catalog. Skills extend the assistant's
capabilities with pre-built workflows and tools.

Examples:
  $ assistant skills list
  $ assistant skills list --json
  $ assistant skills inspect slack
  $ assistant skills inspect resend-setup --json
  $ assistant skills search react
  $ assistant skills search react --limit 5 --json
  $ assistant skills install weather
  $ assistant skills install weather --overwrite
  $ assistant skills uninstall weather
  $ assistant skills add vercel-labs/skills@find-skills
  $ assistant skills add vercel-labs/skills/find-skills --overwrite`,
  subcommands: [
    {
      name: "list",
      description: "List bundled and installed skills",
      options: [
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Lists all bundled and installed skills with their source, state, and
description. Use 'assistant skills inspect <id>' for detailed metadata
or 'assistant skills search' to discover catalog skills.

Examples:
  $ assistant skills list
  $ assistant skills list --json`,
    },
    {
      name: "inspect",
      args: "<skill-id>",
      description: "Show detailed information about a skill",
      options: [
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Arguments:
  skill-id   Skill identifier. Run 'assistant skills list' to see available IDs.

Displays detailed metadata about a skill including its source, state,
description, install metadata (origin, version, content hash), config
entries, tool manifest, activation hints, and feature flags.

Examples:
  $ assistant skills inspect slack
  $ assistant skills inspect resend-setup --json`,
    },
    {
      name: "search",
      args: "<query>",
      description:
        "Search the Vellum catalog, skills.sh, and clawhub community registries",
      options: [
        {
          flags: "--limit <n>",
          description: "Maximum number of community results",
          defaultValue: "10",
        },
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Arguments:
  query    Free-text search term matched against skill names, descriptions,
           and tags. Searches the Vellum catalog, the skills.sh community
           registry, and the clawhub registry.

Displays results from all sources with clear labels. When a skill ID
exists in both the Vellum catalog and a community registry, a conflict
note is shown with guidance on which install command to use.

Examples:
  $ assistant skills search react
  $ assistant skills search "file management" --limit 3
  $ assistant skills search deploy --json`,
    },
    {
      name: "install",
      args: "<skill-id>",
      description: "Install a skill from the catalog",
      options: [
        {
          flags: "--overwrite",
          description: "Replace an already installed skill",
        },
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Arguments:
  skill-id   Skill identifier from the Vellum catalog. Run 'assistant skills list'
             to see available IDs. For community skills, use 'assistant skills add'.

Downloads and installs the skill into the workspace skills directory. If the
skill is already installed, use --overwrite to replace it.

Examples:
  $ assistant skills install weather
  $ assistant skills install weather --overwrite
  $ assistant skills install weather --json`,
    },
    {
      name: "uninstall",
      args: "<skill-id>",
      description: "Uninstall a previously installed skill",
      options: [
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Arguments:
  skill-id   Skill identifier to remove. Run 'assistant skills list' to see
             installed skills.

Removes the skill directory from the workspace. This action cannot be undone.

Examples:
  $ assistant skills uninstall weather
  $ assistant skills uninstall weather --json`,
    },
    {
      name: "add",
      args: "<source>",
      description:
        "Install a community skill from the skills.sh registry (GitHub)",
      options: [
        {
          flags: "--overwrite",
          description: "Replace an already installed skill",
        },
        { flags: "--json", description: "Machine-readable JSON output" },
      ],
      helpText: `
Arguments:
  source   Skill source in one of these formats:
             owner/repo@skill-name
             owner/repo/skill-name
             https://github.com/owner/repo/tree/<branch>/skills/skill-name

Notes:
  Fetches the skill's SKILL.md and supporting files from the specified GitHub
  repository and installs them into the workspace skills directory. An
  install-meta.json file is written with origin metadata for provenance tracking.

Examples:
  $ assistant skills add vercel-labs/skills@find-skills
  $ assistant skills add vercel-labs/skills/find-skills
  $ assistant skills add vercel-labs/skills@find-skills --overwrite`,
    },
  ],
};
