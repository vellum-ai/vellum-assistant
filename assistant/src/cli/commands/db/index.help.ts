/** Declarative help for the `assistant db` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

export const dbHelp: CliCommandHelp = {
  name: "db",
  description: "Inspect and repair the assistant SQLite database",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  subcommands: [
    {
      name: "status",
      description:
        "Show database path, size, key pragmas, and the 5 largest tables",
    },
    {
      name: "repair",
      description: "Run the database repair sequence (integrity check, …)",
    },
    {
      name: "refresh",
      description:
        "Signal all assistant processes to reopen their SQLite database connections",
    },
  ],
};
