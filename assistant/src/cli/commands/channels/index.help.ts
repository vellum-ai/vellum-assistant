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
  description: "Inspect messaging channels and act as their bots",
  helpText: `
Channels are the messaging surfaces the assistant talks over. Built-in
readiness probes cover slack, telegram, whatsapp, email, phone, vellum,
platform, and a2a.

${CHANNELS_PLUGIN_SEARCH_HINT} Plugins can bundle additional channels
from other Vellum users.

Two identities can reach a channel's platform. 'request' acts as the
assistant's own bot on that channel (slack, telegram, discord), resolving
the bot credential from the channel id so no token is handled. Acting as a
person through their OAuth integration is 'assistant oauth request'.

Examples:
  $ assistant channels list
  $ assistant channels get slack
  $ assistant channels request --channel slack /auth.test --json
  $ assistant channels request --channel slack -X POST \\
      -d '{"channel":"D0123456789","limit":20}' /conversations.history --json`,
  subcommands: [
    {
      name: "request",
      args: "<url>",
      description:
        "Call the channel's platform API as the assistant's own bot on that channel (curl-like interface)",
      // The request-shaping options (-X, -H, -d, -G, -I, -o, -s, -v, -i) and
      // the required --channel flag are registered imperatively in
      // request.ts: the repeatable "-H, --header" flag needs a Commander
      // collect parser the declarative contract cannot express, and the
      // options must keep their registration order around it.
      helpText: `
Makes one authenticated request to the channel's platform API as the
assistant's bot. The bot credential is the one the channel's setup wizard
stored; it is resolved from --channel and sent from inside the assistant,
never printed or passed on the command line. Acting as a person through
their OAuth integration is a different identity and stays on
'assistant oauth request --provider <key>'.

Arguments:
  <url>    The API method path, relative to the platform's API host
           (for Slack, '/conversations.history'; for Discord, '/users/@me';
           for Telegram, '/getMe'). The provider supplies the host.

Options:
  --channel <id>   Required. One of: slack, telegram, discord. A channel with
                   no bot credential of its own (phone, vellum) is refused.
  -X <method>      HTTP method (default: GET; POST when -d is given).
  -H 'Key: Value'  Request header, repeatable.
  -d <data>        Request body: inline JSON, @file, or @- for stdin.
  --json           Machine-readable envelope: ok, status, headers, body.

Examples:
  $ assistant channels request --channel slack /auth.test --json
  $ assistant channels request --channel slack -X POST \\
      -d '{"channel":"D0123456789","limit":100}' /conversations.history --json
  $ assistant channels request --channel discord /users/@me --json`,
    },
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
