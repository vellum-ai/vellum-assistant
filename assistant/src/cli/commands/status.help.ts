/** Declarative help for the `assistant status` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const statusHelp: CliCommandHelp = {
  name: "status",
  description: "Show assistant version, workspace, and runtime health",
};
