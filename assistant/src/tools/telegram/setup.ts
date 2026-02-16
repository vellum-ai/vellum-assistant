import { randomUUID } from 'node:crypto';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { setSecureKey } from '../../security/secure-keys.js';
import { assertMetadataWritable, upsertCredentialMetadata } from '../credentials/metadata-store.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('telegram-setup');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 15_000;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<TelegramApiResponse<T>> {
  const response = await fetch(
    `${TELEGRAM_API_BASE}/bot${botToken}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  return response.json() as Promise<TelegramApiResponse<T>>;
}

class TelegramSetupTool implements Tool {
  name = 'telegram_setup';
  description = 'Set up a Telegram bot by verifying the token, registering a webhook, and storing credentials securely. Use when a user provides their Telegram bot token.';
  category = 'integrations';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          bot_token: {
            type: 'string',
            description: 'The Telegram bot token from @BotFather (e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11)',
          },
          webhook_url: {
            type: 'string',
            description: 'The public URL where the gateway receives Telegram webhooks (e.g. https://your-host/webhooks/telegram)',
          },
        },
        required: ['bot_token', 'webhook_url'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const botToken = input.bot_token as string | undefined;
    const webhookUrl = input.webhook_url as string | undefined;

    if (!botToken || typeof botToken !== 'string') {
      return { content: 'Error: bot_token is required', isError: true };
    }
    if (!webhookUrl || typeof webhookUrl !== 'string') {
      return { content: 'Error: webhook_url is required', isError: true };
    }

    try {
      new URL(webhookUrl);
    } catch {
      return { content: 'Error: webhook_url must be a valid URL', isError: true };
    }

    try {
      assertMetadataWritable();
    } catch {
      return {
        content: 'Error: credential metadata file has an unrecognized version; cannot store credentials',
        isError: true,
      };
    }

    let botInfo: TelegramUser;
    try {
      const getMeResponse = await callTelegramApi<TelegramUser>(botToken, 'getMe');
      if (!getMeResponse.ok || !getMeResponse.result) {
        return {
          content: `Error: Invalid bot token. Telegram API returned: ${getMeResponse.description || 'unknown error'}`,
          isError: true,
        };
      }
      botInfo = getMeResponse.result;
    } catch (err) {
      return {
        content: `Error: Failed to verify bot token with Telegram API: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const webhookSecret = randomUUID();

    try {
      const setWebhookResponse = await callTelegramApi(botToken, 'setWebhook', {
        url: webhookUrl,
        secret_token: webhookSecret,
        allowed_updates: ['message'],
      });
      if (!setWebhookResponse.ok) {
        return {
          content: `Error: Failed to register webhook. Telegram API returned: ${setWebhookResponse.description || 'unknown error'}`,
          isError: true,
        };
      }
    } catch (err) {
      return {
        content: `Error: Failed to register webhook: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    try {
      await callTelegramApi(botToken, 'setMyCommands', {
        commands: [{ command: 'new', description: 'Start a new conversation' }],
      });
    } catch (err) {
      log.warn({ err }, 'Failed to register bot commands (non-fatal)');
    }

    const tokenKey = 'credential:telegram:bot_token';
    const secretKey = 'credential:telegram:webhook_secret';

    if (!setSecureKey(tokenKey, botToken)) {
      return { content: 'Error: failed to store bot token in secure storage', isError: true };
    }
    if (!setSecureKey(secretKey, webhookSecret)) {
      return { content: 'Error: failed to store webhook secret in secure storage', isError: true };
    }

    try {
      upsertCredentialMetadata('telegram', 'bot_token', {
        allowedTools: [],
        allowedDomains: ['api.telegram.org'],
        usageDescription: 'Telegram bot authentication token from @BotFather',
      });
      upsertCredentialMetadata('telegram', 'webhook_secret', {
        allowedTools: [],
        allowedDomains: [],
        usageDescription: 'Secret for verifying inbound Telegram webhook requests',
      });
    } catch (err) {
      log.warn({ err }, 'Failed to write credential metadata (non-fatal)');
    }

    const botName = botInfo.username ? `@${botInfo.username}` : botInfo.first_name;
    const lines = [
      `Telegram bot ${botName} has been set up successfully.`,
      '',
      'Completed steps:',
      `- Verified bot: ${botName} (ID: ${botInfo.id})`,
      `- Webhook registered at: ${webhookUrl}`,
      '- Bot command /new registered',
      '- Bot token stored securely (telegram/bot_token)',
      '- Webhook secret generated and stored securely (telegram/webhook_secret)',
      '',
      'To finish, set these environment variables on the gateway service:',
      '  TELEGRAM_BOT_TOKEN=<retrieve from credential vault: telegram/bot_token>',
      '  TELEGRAM_WEBHOOK_SECRET=<retrieve from credential vault: telegram/webhook_secret>',
    ];

    return { content: lines.join('\n'), isError: false };
  }
}

export const telegramSetupTool = new TelegramSetupTool();
