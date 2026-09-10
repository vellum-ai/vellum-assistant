/** Declarative help for the `assistant channels` command. */

import {
  CHANNEL_BOT_PROVIDER,
  CHANNEL_IDS,
} from "@vellumai/service-contracts/channels";

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

/**
 * The channel ids the readiness route accepts: the canonical vocabulary. A
 * channel with no built-in probe reports as unsupported rather than being
 * refused, so the list is the contract's, not a copy kept here.
 */
export const KNOWN_CHANNELS: readonly string[] = CHANNEL_IDS;

/** The channels whose bot the assistant can act as. */
const BOT_CHANNELS = Object.keys(CHANNEL_BOT_PROVIDER).join(", ");

export const CHANNELS_PLUGIN_SEARCH_HINT =
  "If the channel you are looking for is not listed, search the plugin marketplace with 'assistant plugins search <name>'.";

export const channelsHelp: CliCommandHelp = {
  name: "channels",
  description: "Inspect messaging channels and act as their bots",
  helpText: `
Channels are the messaging surfaces the assistant talks over. Channel ids:
${KNOWN_CHANNELS.join(", ")}. A channel without a built-in readiness probe
reports as unsupported.

${CHANNELS_PLUGIN_SEARCH_HINT} Plugins can bundle additional channels
from other Vellum users.

Two identities can reach a channel's platform. 'request' acts as the
assistant's own bot on that channel (${BOT_CHANNELS}), resolving the bot
credential from the channel id so no token is handled. Acting as a person
through their OAuth integration is 'assistant oauth request'.

Examples:
  $ assistant channels list
  $ assistant channels get slack
  $ assistant channels request slack /auth.test --json
  $ assistant channels request slack -X POST \\
      -d '{"channel":"D0123456789","limit":20}' /conversations.history --json`,
  subcommands: [
    {
      name: "request",
      args: "<channel> <url>",
      description:
        "Call the channel's platform API as the assistant's own bot on that channel (curl-like interface)",
      // The request-shaping options (-X, -H, -d, -G, -I, -o, -s, -v, -i) are
      // registered imperatively in request.ts: the repeatable "-H, --header"
      // flag needs a Commander collect parser the declarative contract cannot
      // express, and the options must keep their registration order around
      // it.
      helpText: `
Makes one authenticated request to the channel's platform API as the
assistant's bot. The bot credential is the one the channel's setup wizard
stored; it is resolved from the channel and sent from inside the assistant,
never printed or passed on the command line. Acting as a person through
their OAuth integration is a different identity and stays on
'assistant oauth request --provider <key>'.

This command can do anything the bot's API allows, including sending,
editing, deleting, uploading, and reacting, so it is classified high risk
and asks for approval like any action with irreversible effects. Reads are
not distinguished from writes: the effect is the endpoint's. To send a
message, use the messaging tool, which records what it sent; do not post
through this command.

Arguments:
  <channel>  One of: ${BOT_CHANNELS}. A channel with no bot credential of
             its own (phone, vellum) is refused.
  <url>      The API method path, relative to the platform's API host
             (for Slack, '/conversations.history'; for Discord, '/users/@me';
             for Telegram, '/getMe'). The provider supplies the host.

Options:
  -X <method>      HTTP method (default: GET; POST when -d is given).
  -H 'Key: Value'  Request header, repeatable.
  -d <data>        Request body: inline JSON, @file, or @- for stdin.
  --json           Machine-readable envelope: ok, status, headers, body.

Examples:
  $ assistant channels request slack /auth.test --json
  $ assistant channels request slack -X POST \\
      -d '{"channel":"D0123456789","limit":100}' /conversations.history --json
  $ assistant channels request discord /users/@me --json`,
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
