/** Declarative help for the `assistant pending` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const pendingHelp: CliCommandHelp = {
  name: "pending",
  description:
    "Inspect pending interactions (confirmations, secrets, host proxy requests)",
  subcommands: [
    {
      name: "list",
      description: "List all pending interactions across all conversations",
      options: [
        {
          flags: "--kind <kind>",
          description: "Filter by kind (confirmation, secret, host_bash, etc.)",
        },
        {
          flags: "--conversation <id>",
          description: "Filter by conversation ID",
        },
        { flags: "--json", description: "Output as JSON" },
      ],
    },
  ],
};
