import * as net from 'node:net';

import type { SlackChannelConfigRequest } from '../ipc-protocol.js';
import { defineHandlers, type HandlerContext, log } from './shared.js';
import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from './config-slack-channel.js';

export async function handleSlackChannelConfig(
  msg: SlackChannelConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    switch (msg.action) {
      case 'get': {
        const result = getSlackChannelConfig();
        ctx.send(socket, { type: 'slack_channel_config_response', ...result });
        return;
      }

      case 'set': {
        const result = await setSlackChannelConfig(msg.botToken, msg.appToken);
        ctx.send(socket, { type: 'slack_channel_config_response', ...result });
        return;
      }

      case 'clear': {
        const result = clearSlackChannelConfig();
        ctx.send(socket, { type: 'slack_channel_config_response', ...result });
        return;
      }

      default: {
        ctx.send(socket, {
          type: 'slack_channel_config_response',
          success: false,
          hasBotToken: false,
          hasAppToken: false,
          connected: false,
          error: `Unknown action: ${String(msg.action)}`,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'slack_channel_config handler error');
    ctx.send(socket, {
      type: 'slack_channel_config_response',
      success: false,
      hasBotToken: false,
      hasAppToken: false,
      connected: false,
      error: message,
    });
  }
}

export const slackChannelHandlers = defineHandlers({
  slack_channel_config: handleSlackChannelConfig,
});
