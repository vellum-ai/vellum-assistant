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
import { writeError } from "../../output.js";
import {
  attachRequestOptions,
  type AuthenticatedRequestOptions,
  runAuthenticatedRequest,
} from "../oauth/request.js";
import { CHANNELS_PLUGIN_SEARCH_HINT } from "./index.help.js";

/** The channels whose bot credential this command can act with. */
export const REQUESTABLE_CHANNELS: readonly string[] =
  Object.keys(CHANNEL_BOT_PROVIDER);

/**
 * The provider key holding a channel's bot credential, or `undefined` when
 * the channel has none (or is not a built-in channel at all).
 */
export function botProviderForChannel(channel: string): string | undefined {
  return Object.entries(CHANNEL_BOT_PROVIDER).find(
    ([channelId]) => channelId === channel,
  )?.[1];
}

export function registerChannelsRequestCommand(channels: Command): void {
  attachRequestOptions(subcommand(channels, "request")).action(
    async (
      channel: string,
      url: string,
      opts: AuthenticatedRequestOptions,
      cmd: Command,
    ) => {
      const providerKey = botProviderForChannel(channel);
      if (!providerKey) {
        writeError(
          cmd,
          `Channel "${channel}" has no bot credential to request with. Channels with one: ${REQUESTABLE_CHANNELS.join(", ")}. ${CHANNELS_PLUGIN_SEARCH_HINT}`,
        );
        process.exitCode = 1;
        return;
      }
      await runAuthenticatedRequest({
        providerKey,
        url,
        opts,
        diagnosticsHint: `For channel diagnostics, run 'assistant channels get ${channel}'.`,
        cmd,
      });
    },
  );
}
