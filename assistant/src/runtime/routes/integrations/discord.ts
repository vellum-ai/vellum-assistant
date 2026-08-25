/**
 * Route handlers for Discord channel configuration.
 *
 * GET    /v1/integrations/discord/config: whether a bot token is stored
 * POST   /v1/integrations/discord/config: validate and store a bot token
 * DELETE /v1/integrations/discord/config: clear it, disconnecting the bot
 *
 * The bot the assistant is reached through, not the user-scoped `discord`
 * OAuth provider, which is a separate surface.
 */

import { z } from "zod";

import {
  clearDiscordChannelConfig,
  DiscordChannelConfigResultSchema,
  getDiscordChannelConfig,
  setDiscordChannelConfig,
} from "../../../daemon/handlers/config-discord-channel.js";
import { ACTOR_PRINCIPALS } from "../../auth/route-policy.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetDiscordConfig() {
  return getDiscordChannelConfig();
}

async function handleSetDiscordConfig({ body = {} }: RouteHandlerArgs) {
  const { botToken } = body as { botToken?: string };
  const result = await setDiscordChannelConfig(botToken);
  if (!result.success) {
    throw new BadRequestError(
      result.error ?? "Failed to set Discord channel config",
    );
  }
  return result;
}

async function handleClearDiscordConfig() {
  return clearDiscordChannelConfig();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "integrations_discord_config_get",
    endpoint: "integrations/discord/config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get Discord config",
    description: "Check whether a Discord bot token is configured.",
    tags: ["integrations"],
    responseBody: DiscordChannelConfigResultSchema,
    handler: () => handleGetDiscordConfig(),
  },
  {
    operationId: "integrations_discord_config_post",
    endpoint: "integrations/discord/config",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set Discord config",
    description:
      "Validate a Discord bot token and store it. Storing it is what " +
      "connects the bot: the gateway's Discord client is credential-gated " +
      "and starts on the watcher's next tick.",
    tags: ["integrations"],
    handler: handleSetDiscordConfig,
    requestBody: z.object({
      botToken: z.string().describe("Discord bot token"),
    }),
    responseBody: DiscordChannelConfigResultSchema,
  },
  {
    operationId: "integrations_discord_config_delete",
    endpoint: "integrations/discord/config",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Clear Discord config",
    description:
      "Clear the stored Discord bot token, which disconnects the bot on the " +
      "gateway's next watcher tick. Room choices are left alone.",
    tags: ["integrations"],
    responseBody: DiscordChannelConfigResultSchema,
    handler: () => handleClearDiscordConfig(),
  },
];
