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
import { BadRequestError, ServiceUnavailableError } from "../errors.js";
import { parseBody } from "../parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

/**
 * One named schema for the connect body, parsed at the boundary and reused as
 * the route's declaration. `requestBody` is a codegen signal, not a runtime
 * check: the router hands the body straight to the handler, so a cast here
 * would narrow nothing while a bot token flowed to secure storage.
 */
const SetDiscordConfigBodySchema = z.object({
  botToken: z.string().min(1).describe("Discord bot token"),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetDiscordConfig() {
  return getDiscordChannelConfig();
}

async function handleSetDiscordConfig({ body = {} }: RouteHandlerArgs) {
  const { botToken } = parseBody(SetDiscordConfigBodySchema, body);
  const result = await setDiscordChannelConfig(botToken);
  if (!result.success) {
    throw new BadRequestError(
      result.error ?? "Failed to set Discord channel config",
    );
  }
  return result;
}

async function handleClearDiscordConfig() {
  const result = await clearDiscordChannelConfig();
  if (!result.success) {
    // The token is still stored and the bot still connected; a 200 envelope
    // here reads as a completed disconnect to every generated client.
    throw new ServiceUnavailableError(
      result.error ?? "Failed to clear Discord channel config",
    );
  }
  return result;
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
    requestBody: SetDiscordConfigBodySchema,
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
