/** Declarative help for the `assistant monitoring` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const monitoringHelp: CliCommandHelp = {
  name: "monitoring",
  description: "Manage the resource monitor process (start/stop/status)",
  helpText: `
The resource monitor samples the container's own cgroup memory + workspace disk
in a separate OS process, off the assistant's main event loop, so it keeps
recording during a main-thread freeze and its samples survive an OOM SIGKILL.
The daemon owns the process, so it is spawned as a child of the daemon and shows
up in \`assistant ps\`.

The monitor runs by default — the daemon spawns it at every boot. \`stop\`
pauses it for the current daemon session only; it respawns on the next boot.
Samples and high-memory snapshots are written under the data directory
reported by \`status\`.

Examples:
  $ assistant monitoring start
  $ assistant monitoring status
  $ assistant monitoring stop`,
  subcommands: [
    {
      name: "start",
      description: "Start the resource monitor process",
      options: [
        {
          flags: "--json",
          description: "Emit raw JSON instead of a formatted summary",
        },
      ],
    },
    {
      name: "stop",
      description:
        "Stop the resource monitor process until the next daemon boot",
      options: [
        {
          flags: "--json",
          description: "Emit raw JSON instead of a formatted summary",
        },
      ],
    },
    {
      name: "status",
      description: "Report the monitor process state and the latest sample",
      options: [
        {
          flags: "--json",
          description: "Emit raw JSON instead of a formatted summary",
        },
      ],
    },
  ],
};
