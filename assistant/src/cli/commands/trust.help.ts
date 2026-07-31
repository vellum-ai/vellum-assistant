/** Declarative help for the `assistant trust` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const trustHelp: CliCommandHelp = {
  name: "trust",
  description: "View tool trust rules (allow-list patterns for tool use)",
  helpText: `
Trust rules define which tool invocations the assistant is allowed to
execute without prompting. Each rule matches a specific tool and a
pattern (regular expression) against the tool input.

Examples:
  $ assistant trust list                List user-modified trust rules
  $ assistant trust list --all          Include unmodified defaults`,
  subcommands: [
    {
      name: "list",
      description: "List trust rules",
      options: [
        { flags: "--all", description: "Include unmodified default rules" },
        { flags: "--tool <name>", description: "Filter by tool name" },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Patterns are regular expressions (regex), not globs.

Options:
  --all           Include unmodified default rules in the output.
  --tool <name>   Filter results to rules for the named tool.
  --json          Output as compact JSON instead of a table.

Examples:
  $ assistant trust list
  $ assistant trust list --all
  $ assistant trust list --tool bash
  $ assistant trust list --json`,
    },
  ],
};
