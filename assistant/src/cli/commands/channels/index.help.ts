/** Declarative help for the `assistant channels` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

/** All channel IDs the readiness service knows about. Mirrors channels/types.ts. */
export const KNOWN_CHANNELS = [
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "platform",
  "a2a",
] as const;

export const channelsHelp: CliCommandHelp = {
  name: "channels",
  description:
    "Inspect and repair messaging channels (slack, telegram, email, etc.)",
  helpText: `
Channels are the messaging surfaces the assistant talks over — slack,
telegram, whatsapp, email, phone, vellum, platform, a2a. Each channel
has a probe that reports whether it's configured and reachable.

  list                    Overview of every channel + ready state
  get <channel>           Live snapshot of one channel (always re-probes)

Examples:
  $ assistant channels list
  $ assistant channels get slack`,
  subcommands: [
    {
      name: "list",
      description: "Show readiness state for every configured channel",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
        {
          flags: "--remote",
          description:
            "Include remote checks (live network round-trip per channel)",
          defaultValue: false,
        },
      ],
    },
    {
      name: "get",
      description:
        "Live readiness snapshot for one channel (always re-probes; no caching)",
      arguments: [
        {
          name: "<channel>",
          description: `Channel id: ${KNOWN_CHANNELS.join(", ")}`,
        },
      ],
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
    },
  ],
};
