import * as net from 'node:net';
import { loadRawConfig, saveRawConfig } from '../../config/loader.js';
import { postToSlackWebhook } from '../../slack/slack-webhook.js';
import { getApp } from '../../memory/app-store.js';
import type {
  ShareToSlackRequest,
  SlackWebhookConfigRequest,
} from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

export async function handleShareToSlack(
  msg: ShareToSlackRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    const config = loadRawConfig();
    const webhookUrl = config.slackWebhookUrl as string | undefined;
    if (!webhookUrl) {
      ctx.send(socket, {
        type: 'share_to_slack_response',
        success: false,
        error: 'No Slack webhook URL configured. Provide one here in the chat, or set it from the Settings page.',
      });
      return;
    }

    const app = getApp(msg.appId);
    if (!app) {
      ctx.send(socket, {
        type: 'share_to_slack_response',
        success: false,
        error: `App not found: ${msg.appId}`,
      });
      return;
    }

    await postToSlackWebhook(
      webhookUrl,
      app.name,
      app.description ?? '',
      '\u{1F4F1}',
    );

    ctx.send(socket, { type: 'share_to_slack_response', success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, appId: msg.appId }, 'Failed to share app to Slack');
    ctx.send(socket, {
      type: 'share_to_slack_response',
      success: false,
      error: message,
    });
  }
}

export function handleSlackWebhookConfig(
  msg: SlackWebhookConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const config = loadRawConfig();
    if (msg.action === 'get') {
      ctx.send(socket, {
        type: 'slack_webhook_config_response',
        webhookUrl: (config.slackWebhookUrl as string) ?? undefined,
        success: true,
      });
    } else {
      config.slackWebhookUrl = msg.webhookUrl ?? '';
      saveRawConfig(config);
      ctx.send(socket, {
        type: 'slack_webhook_config_response',
        success: true,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Slack webhook config');
    ctx.send(socket, {
      type: 'slack_webhook_config_response',
      success: false,
      error: message,
    });
  }
}

export const slackHandlers = defineHandlers({
  share_to_slack: handleShareToSlack,
  slack_webhook_config: handleSlackWebhookConfig,
});
