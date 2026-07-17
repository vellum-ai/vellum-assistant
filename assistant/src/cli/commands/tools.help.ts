/** Declarative help for the `assistant tools` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const toolsHelp: CliCommandHelp = {
  name: "tools",
  description: "Inspect tools registered with the running assistant",
  helpText: `
Tools are registered with the daemon from four sources: core built-ins,
skills, external plugins, and MCP servers. The "source" column reports the
origin as "core" or "<kind>:<id>" (e.g. "plugin:echo", "skill:my-skill",
"mcp:linear"). The risk level is the author-asserted default band used for
permission gating, not the runtime-classified risk of a specific call.

By default the global registry is listed. Pass --conversation to scope the
list to the tools available to one conversation as of its most recent turn —
including skill/MCP tools it registered over its lifecycle.

'tools run' executes a single tool directly, outside the agent loop. It runs
in-process from the filesystem (core built-ins + workspace tools), and is
non-interactive and non-guardian: read-only / low-risk tools execute, while
prompt-gated tools are auto-denied (there is no client to approve them). A
tool error exits non-zero so it composes in scripts.

Examples:
  $ assistant tools list
  $ assistant tools ls
  $ assistant tools list --json
  $ assistant tools list --conversation conv_abc123
  $ assistant tools list --agent researcher
  $ assistant tools list --agent subagent_abc123 --json
  $ assistant tools run web_fetch --input '{"url":"https://example.com"}'
  $ assistant tools run file_read --input-file args.json
  $ echo '{"path":"."}' | assistant tools run list_dir --input-file -`,
  subcommands: [
    {
      name: "list",
      description: "List all registered tools with their source and risk level",
      options: [
        {
          flags: "--json",
          description: "Emit machine-readable JSON instead of a table",
        },
        {
          flags: "--conversation <id>",
          description:
            "Scope to one conversation's tools as of its most recent turn — run 'assistant conversations list' to find the id",
        },
        {
          flags: "--agent <role|subagent-id>",
          description:
            "Show tools available to a subagent role (general, researcher, coder, planner, investigator, advisor) or a live subagent by its id. Simulates the subagent tool projection: role allowlist + subagent-only gating.",
        },
      ],
    },
    {
      name: "run",
      description: "Execute a single registered tool directly",
      arguments: [
        {
          name: "<name>",
          description: "Name of the registered tool to execute",
        },
      ],
      options: [
        {
          flags: "--input <json>",
          description: "Tool input as a JSON object (default: {})",
        },
        {
          flags: "--input-file <path>",
          description: 'Read JSON input from a file ("-" reads stdin)',
        },
        {
          flags: "--json",
          description: "Emit the full machine-readable result as JSON",
        },
      ],
    },
  ],
};
