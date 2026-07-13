/** Declarative help for the `assistant telemetry` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const telemetryHelp: CliCommandHelp = {
  name: "telemetry",
  description: "Manage telemetry reporting",
  subcommands: [
    {
      name: "flush",
      description: "Force-flush all pending telemetry events to the platform",
    },
  ],
};
