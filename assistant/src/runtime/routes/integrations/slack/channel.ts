/**
 * Route handlers for Slack channel configuration.
 *
 * GET    /v1/integrations/slack/channel/config        — get current config status
 * POST   /v1/integrations/slack/channel/config        — validate and store credentials
 * PATCH  /v1/integrations/slack/channel/config        — update channel settings
 * DELETE /v1/integrations/slack/channel/config        — clear credentials
 */

import { z } from "zod";

import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  patchSlackChannelConfig,
  setSlackChannelConfig,
  SlackChannelConfigResultSchema,
  SlackThreadMode,
} from "../../../../daemon/handlers/config-slack-channel.js";
import { ACTOR_PRINCIPALS } from "../../../auth/route-policy.js";
import { BadRequestError } from "../../errors.js";
import { parseBody } from "../../parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "../../types.js";

// ---------------------------------------------------------------------------
// Body schemas
//
// Each is named once and used twice: as the route's `requestBody`, a codegen
// signal only, and by `parseBody` in the handler, which is what rejects a
// malformed request. One declaration keeps the wire contract and the runtime
// check in agreement.
// ---------------------------------------------------------------------------

/**
 * Every field is optional because `setSlackChannelConfig` accepts any subset:
 * a user token alone is a valid update that leaves the bot and app tokens in
 * place. The wizard requires both bot and app tokens, and enforces that in
 * `use-save-slack-config.ts` where that requirement belongs.
 */
const SetSlackChannelConfigBody = z.object({
  botToken: z.string().optional().describe("Slack bot token"),
  appToken: z.string().optional().describe("Slack app-level token"),
  userToken: z
    .string()
    .optional()
    .describe("Slack user token, for reading channels the bot is not in"),
});

const PatchSlackChannelConfigBody = z.object({
  threadMode: SlackThreadMode.describe(
    "Controls whether the bot follows threads after an initial @mention",
  ).optional(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetSlackChannelConfig() {
  return getSlackChannelConfig();
}

export async function handleSetSlackChannelConfig({
  body = {},
}: RouteHandlerArgs) {
  const { botToken, appToken, userToken } = parseBody(
    SetSlackChannelConfigBody,
    body,
  );
  const result = await setSlackChannelConfig(botToken, appToken, userToken);
  if (!result.success) {
    throw new BadRequestError(result.error ?? "Failed to set Slack config");
  }
  return result;
}

async function handlePatchSlackChannelConfig({ body = {} }: RouteHandlerArgs) {
  const { threadMode } = parseBody(PatchSlackChannelConfigBody, body);
  if (threadMode !== undefined) {
    const parsed = SlackThreadMode.safeParse(threadMode);
    if (!parsed.success) {
      throw new BadRequestError(
        "threadMode must be 'mention_only' or 'mention_then_thread'",
      );
    }
    patchSlackChannelConfig(parsed.data);
  }
  return getSlackChannelConfig();
}

async function handleClearSlackChannelConfig() {
  return clearSlackChannelConfig();
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "integrations_slack_channel_config_get",
    endpoint: "integrations/slack/channel/config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get Slack channel config",
    description: "Check current Slack channel configuration status.",
    tags: ["integrations"],
    responseBody: SlackChannelConfigResultSchema,
    handler: () => handleGetSlackChannelConfig(),
  },
  {
    operationId: "integrations_slack_channel_config_post",
    endpoint: "integrations/slack/channel/config",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set Slack channel config",
    description: "Validate and store Slack channel credentials.",
    tags: ["integrations"],
    handler: handleSetSlackChannelConfig,
    requestBody: SetSlackChannelConfigBody,
    responseBody: SlackChannelConfigResultSchema,
  },
  {
    operationId: "integrations_slack_channel_config_patch",
    endpoint: "integrations/slack/channel/config",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Update Slack channel settings",
    description: "Update Slack channel behavior settings (e.g. thread mode).",
    tags: ["integrations"],
    handler: handlePatchSlackChannelConfig,
    requestBody: PatchSlackChannelConfigBody,
    responseBody: SlackChannelConfigResultSchema,
  },
  {
    operationId: "integrations_slack_channel_config_delete",
    endpoint: "integrations/slack/channel/config",
    method: "DELETE",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Clear Slack channel config",
    description: "Clear stored Slack channel credentials.",
    tags: ["integrations"],
    responseBody: SlackChannelConfigResultSchema,
    handler: () => handleClearSlackChannelConfig(),
  },
];
