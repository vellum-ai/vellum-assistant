import * as net from "node:net";

import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type { SlackWebhookConfigRequest } from "../ipc-protocol.js";
import { defineHandlers, type HandlerContext, log } from "./shared.js";

export function handleSlackWebhookConfig(
  msg: SlackWebhookConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const config = loadRawConfig();
    if (msg.action === "get") {
      ctx.send(socket, {
        type: "slack_webhook_config_response",
        webhookUrl: (config.slackWebhookUrl as string) ?? undefined,
        success: true,
      });
    } else {
      config.slackWebhookUrl = msg.webhookUrl ?? "";
      saveRawConfig(config);
      ctx.send(socket, {
        type: "slack_webhook_config_response",
        success: true,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to handle Slack webhook config");
    ctx.send(socket, {
      type: "slack_webhook_config_response",
      success: false,
      error: message,
    });
  }
}

export const slackHandlers = defineHandlers({
  slack_webhook_config: handleSlackWebhookConfig,
});
