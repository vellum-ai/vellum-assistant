/**
 * Route handlers for Slack channel configuration.
 *
 * GET    /v1/integrations/slack/channel/config        — get current config status
 * POST   /v1/integrations/slack/channel/config        — validate and store credentials
 * DELETE /v1/integrations/slack/channel/config        — clear credentials
 */

import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from "../../../../daemon/handlers/config-slack-channel.js";
import { BadRequestError } from "../../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../../types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetSlackChannelConfig() {
  return getSlackChannelConfig();
}

export async function handleSetSlackChannelConfig({
  body = {},
}: RouteHandlerArgs) {
  const { botToken, appToken, userToken } = body as {
    botToken?: string;
    appToken?: string;
    userToken?: string;
  };
  const result = await setSlackChannelConfig(botToken, appToken, userToken);
  if (!result.success) {
    throw new BadRequestError(
      (result as { error?: string }).error ?? "Failed to set Slack config",
    );
  }
  return result;
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
    summary: "Get Slack channel config",
    description: "Check current Slack channel configuration status.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleGetSlackChannelConfig(),
  },
  {
    operationId: "integrations_slack_channel_config_post",
    endpoint: "integrations/slack/channel/config",
    method: "POST",
    summary: "Set Slack channel config",
    description: "Validate and store Slack channel credentials.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleSetSlackChannelConfig,
  },
  {
    operationId: "integrations_slack_channel_config_delete",
    endpoint: "integrations/slack/channel/config",
    method: "DELETE",
    summary: "Clear Slack channel config",
    description: "Clear stored Slack channel credentials.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleClearSlackChannelConfig(),
  },
];
