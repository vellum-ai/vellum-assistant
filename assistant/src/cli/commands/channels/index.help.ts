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

export const CHANNELS_PLUGIN_SEARCH_HINT =
  "If the channel you are looking for is not listed, search the plugin marketplace with 'assistant plugins search <name>'.";

export const channelsHelp: CliCommandHelp = {
  name: "channels",
  description: "Inspect and repair messaging channels",
  helpText: `
Channels are the messaging surfaces the assistant talks over. Built-in
readiness probes cover slack, telegram, whatsapp, email, phone, vellum,
platform, and a2a.

${CHANNELS_PLUGIN_SEARCH_HINT} Plugins can bundle additional channels
from other Vellum users.

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
      helpText: `
Shows readiness for every built-in channel.

${CHANNELS_PLUGIN_SEARCH_HINT}

Examples:
  $ assistant channels list
  $ assistant channels list --json`,
    },
    {
      name: "get",
      description:
        "Live readiness snapshot for one channel (always re-probes; no caching)",
      arguments: [
        {
          name: "<channel>",
          description: `Channel id: ${KNOWN_CHANNELS.join(", ")}. If the channel is not in this list, run 'assistant plugins search <name>'.`,
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
