/** Declarative help for the `assistant telemetry` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const telemetryHelp: CliCommandHelp = {
  name: "telemetry",
  description: "Manage telemetry reporting",
  subcommands: [
    {
      name: "flush",
      description: "Force-flush all pending telemetry events to the platform",
      helpText: `
Reports how many events reached the platform: 'sent' (POSTed), 'persisted'
(confirmed written), and 'dropped' (sent - persisted — server-side drops plus
events skipped at ingest validation). When nothing ships, prints why (e.g.
nothing pending, opted out, not signed in).

Pass --json for the raw summary:
  { "flushed": true, "sent": 44, "persisted": 40, "dropped": 4 }
  { "flushed": false, "reason": "opted-out" }

Examples:
  $ assistant telemetry flush
  $ assistant telemetry flush --json`,
    },
  ],
};
