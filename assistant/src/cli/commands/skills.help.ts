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
    {
      name: "companion",
      description:
        "Manage companion files (scripts, reference docs) inside a managed skill",
      helpText: `
Companion files are the files a skill ships alongside its SKILL.md — most often
a scripts/ helper the skill body invokes. Copy a proven script in with 'add'
instead of pasting its contents into the skill body, so the skill reruns the
exact code that worked.

These verbs write only into skills the assistant authored itself (install-meta
author "assistant"). A skill you wrote by hand is yours to edit directly with
your own tools; there is deliberately no flag to override that.

Creating the skill itself is a separate operation — see the skill-management
skill's scaffold_managed_skill tool.

Examples:
  $ assistant skills companion add export-report --path scripts/export.py --from /tmp/export.py
  $ assistant skills companion list export-report
  $ assistant skills companion remove export-report --path scripts/export.py`,
      subcommands: [
        {
          name: "add",
          args: "<skill-id>",
          description: "Copy an on-disk file into a managed skill",
          options: [
            {
              flags: "--path <relative-path>",
              description:
                "Destination path inside the skill, e.g. scripts/export.py",
              required: true,
            },
            {
              flags: "--from <absolute-path>",
              description: "Absolute path of the existing file to copy in",
              required: true,
            },
            {
              flags: "--overwrite",
              description: "Replace an existing companion file at --path",
            },
            { flags: "--json", description: "Machine-readable JSON output" },
          ],
          helpText: `
Arguments:
  skill-id   Managed skill to copy into. Run 'assistant skills list' to see
             managed skills.

Notes:
  --path is relative to the skill directory and may not escape it or overwrite
  the store-owned files (SKILL.md, TOOLS.json, install-meta.json, version.json).
  --from must be an absolute path to a regular file of at most 1 MiB.
  The skill must be assistant-authored; the command fails otherwise.

Examples:
  $ assistant skills companion add export-report --path scripts/export.py --from /tmp/export.py
  $ assistant skills companion add export-report --path scripts/export.py --from /tmp/v2.py --overwrite`,
        },
        {
          name: "list",
          args: "<skill-id>",
          description: "List a managed skill's companion files",
          options: [
            { flags: "--json", description: "Machine-readable JSON output" },
          ],
          helpText: `
Arguments:
  skill-id   Managed skill to inspect. Run 'assistant skills list' to see
             managed skills.

Lists every file in the skill directory except the store-owned files, with its
size in bytes.

Examples:
  $ assistant skills companion list export-report
  $ assistant skills companion list export-report --json`,
        },
        {
          name: "remove",
          args: "<skill-id>",
          description: "Delete one companion file from a managed skill",
          options: [
            {
              flags: "--path <relative-path>",
              description:
                "Companion file to delete, as shown by 'companion list'",
              required: true,
            },
            { flags: "--json", description: "Machine-readable JSON output" },
          ],
          helpText: `
Arguments:
  skill-id   Managed skill to delete from. Run 'assistant skills list' to see
             managed skills.

Notes:
  Deletes a single file and cannot remove the store-owned files. The skill must
  be assistant-authored. To delete the whole skill, use
  'assistant skills uninstall <skill-id>'.

Examples:
  $ assistant skills companion remove export-report --path scripts/export.py`,
        },
      ],
    },
  ],
};
