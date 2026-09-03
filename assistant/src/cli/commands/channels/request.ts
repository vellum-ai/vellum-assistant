/**
 * `assistant channels request`: call a channel's platform API as the
 * assistant's own bot on that channel.
 *
 * This is the bot-identity door. A channel's bot credential (the token the
 * setup wizard stored) and a person's OAuth integration for the same brand
 * are different identities that reach different things, and the provider
 * keys do not say which is which (`slack_channel` is the bot, `slack` is the
 * person; `telegram` is the bot). Keying the request on the channel id
 * resolves the bot credential through the one map that owns that fact,
 * `CHANNEL_BOT_PROVIDER`, so a caller names the channel and never chooses a
 * provider. Acting as the person is `oauth request`.
 *
 * The request itself is the same authenticated request `oauth request`
 * makes: the route resolves the provider's connection and injects the
 * credential, so no token is ever handled here. A channel this map does not
 * name has no bot credential of its own (phone, vellum, platform) or is not
 * built in, and the command says so rather than guessing a provider.
 */

import { CHANNEL_BOT_PROVIDER } from "@vellumai/service-contracts/channels";
import type { Command } from "commander";

import { subcommand } from "../../lib/cli-command-help.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import {
  attachRequestOptions,
  type AuthenticatedRequestOptions,
  runAuthenticatedRequest,
} from "../oauth/request.js";
import { CHANNELS_PLUGIN_SEARCH_HINT } from "./index.help.js";

/** The channels whose bot credential this command can act with. */
export const REQUESTABLE_CHANNELS = Object.keys(
  CHANNEL_BOT_PROVIDER,
) as ReadonlyArray<keyof typeof CHANNEL_BOT_PROVIDER>;

/**
 * The provider key holding a channel's bot credential, or `undefined` when
 * the channel has none (or is not a built-in channel at all).
 */
export function botProviderForChannel(channel: string): string | undefined {
  // Own-property lookup: an inherited name (`constructor`, `toString`) is not
  // a channel and must not resolve to a function as if it were a provider.
  return Object.hasOwn(CHANNEL_BOT_PROVIDER, channel)
    ? (CHANNEL_BOT_PROVIDER as Readonly<Record<string, string>>)[channel]
    : undefined;
}

export function registerChannelsRequestCommand(channels: Command): void {
  attachRequestOptions(
    subcommand(channels, "request").requiredOption(
      "--channel <id>",
      `Channel whose bot makes the request: ${REQUESTABLE_CHANNELS.join(", ")}`,
    ),
  ).action(
    async (
      url: string,
      opts: AuthenticatedRequestOptions & { channel: string },
      cmd: Command,
    ) => {
      const providerKey = botProviderForChannel(opts.channel);
      if (!providerKey) {
        const error = `Channel "${opts.channel}" has no bot credential to request with. Channels with one: ${REQUESTABLE_CHANNELS.join(", ")}. ${CHANNELS_PLUGIN_SEARCH_HINT}`;
        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, { ok: false, error });
        } else {
          process.stderr.write(error + "\n");
        }
        process.exitCode = 1;
        return;
      }
      await runAuthenticatedRequest({
        providerKey,
        url,
        opts,
        diagnosticsHint: `For channel diagnostics, run 'assistant channels get ${opts.channel}'.`,
        cmd,
      });
    },
  );
}
