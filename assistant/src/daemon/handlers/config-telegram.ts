import * as net from 'node:net';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../../security/secure-keys.js';
import { upsertCredentialMetadata, deleteCredentialMetadata, getCredentialMetadata } from '../../tools/credentials/metadata-store.js';
import { triggerGatewayReconcile } from './config-ingress.js';
import { getIngressPublicBaseUrl } from '../../config/env.js';
import type { TelegramConfigRequest } from '../ipc-protocol.js';
import { log, defineHandlers, type HandlerContext } from './shared.js';

const TELEGRAM_BOT_TOKEN_IN_URL_PATTERN = /\/bot\d{8,10}:[A-Za-z0-9_-]{30,120}\//g;
const TELEGRAM_BOT_TOKEN_PATTERN = /(?<![A-Za-z0-9_])\d{8,10}:[A-Za-z0-9_-]{30,120}(?![A-Za-z0-9_])/g;

function redactTelegramBotTokens(value: string): string {
  return value
    .replace(TELEGRAM_BOT_TOKEN_IN_URL_PATTERN, '/bot[REDACTED]/')
    .replace(TELEGRAM_BOT_TOKEN_PATTERN, '[REDACTED]');
}

export function summarizeTelegramError(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
  } else {
    parts.push(String(err));
  }
  const path = (err as { path?: unknown })?.path;
  if (typeof path === 'string' && path.length > 0) {
    parts.push(`path=${path}`);
  }
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && code.length > 0) {
    parts.push(`code=${code}`);
  }
  return redactTelegramBotTokens(parts.join(' '));
}

export async function handleTelegramConfig(
  msg: TelegramConfigRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  try {
    if (msg.action === 'get') {
      const hasBotToken = !!getSecureKey('credential:telegram:bot_token');
      const hasWebhookSecret = !!getSecureKey('credential:telegram:webhook_secret');
      const meta = getCredentialMetadata('telegram', 'bot_token');
      const botUsername = meta?.accountInfo ?? undefined;
      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken,
        botUsername,
        connected: hasBotToken && hasWebhookSecret,
        hasWebhookSecret,
      });
    } else if (msg.action === 'set') {
      // Resolve token: prefer explicit msg.botToken, fall back to secure storage.
      // Track provenance so we only rollback tokens that were freshly provided.
      const isNewToken = !!msg.botToken;
      const botToken = msg.botToken || getSecureKey('credential:telegram:bot_token');
      if (!botToken) {
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: 'botToken is required for set action',
        });
        return;
      }

      // Validate token via Telegram getMe API
      let botUsername: string;
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
        if (!res.ok) {
          const body = await res.text();
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: false,
            connected: false,
            hasWebhookSecret: false,
            error: `Telegram API validation failed: ${body}`,
          });
          return;
        }
        const data = await res.json() as { ok: boolean; result?: { username?: string } };
        if (!data.ok || !data.result?.username) {
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: false,
            connected: false,
            hasWebhookSecret: false,
            error: 'Telegram API returned unexpected response',
          });
          return;
        }
        botUsername = data.result.username;
      } catch (err) {
        const message = summarizeTelegramError(err);
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: `Failed to validate bot token: ${message}`,
        });
        return;
      }

      // Store bot token securely
      const stored = setSecureKey('credential:telegram:bot_token', botToken);
      if (!stored) {
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: 'Failed to store bot token in secure storage',
        });
        return;
      }

      // Store metadata with bot username
      upsertCredentialMetadata('telegram', 'bot_token', {
        accountInfo: botUsername,
      });

      // Ensure webhook secret exists (generate if missing)
      let hasWebhookSecret = !!getSecureKey('credential:telegram:webhook_secret');
      if (!hasWebhookSecret) {
        const { randomUUID } = await import('node:crypto');
        const webhookSecret = randomUUID();
        const secretStored = setSecureKey('credential:telegram:webhook_secret', webhookSecret);
        if (secretStored) {
          upsertCredentialMetadata('telegram', 'webhook_secret', {});
          hasWebhookSecret = true;
        } else {
          // Only roll back the bot token if it was freshly provided.
          // When the token came from secure storage it was already valid
          // configuration; deleting it would destroy working state.
          if (isNewToken) {
            deleteSecureKey('credential:telegram:bot_token');
            deleteCredentialMetadata('telegram', 'bot_token');
          }
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: !isNewToken,
            connected: false,
            hasWebhookSecret: false,
            error: 'Failed to store webhook secret',
          });
          return;
        }
      } else {
        // Self-heal: ensure metadata exists even when the secret was
        // already present (covers previously lost/corrupted metadata).
        upsertCredentialMetadata('telegram', 'webhook_secret', {});
      }

      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken: true,
        botUsername,
        connected: true,
        hasWebhookSecret,
      });

      // Trigger gateway reconcile so the webhook registration updates immediately
      const effectiveUrl = getIngressPublicBaseUrl();
      if (effectiveUrl) {
        triggerGatewayReconcile(effectiveUrl);
      }
    } else if (msg.action === 'clear') {
      // Deregister the Telegram webhook before deleting credentials.
      // The gateway reconcile short-circuits when credentials are absent,
      // so we must call the Telegram API directly while the token is still
      // available.
      const botToken = getSecureKey('credential:telegram:bot_token');
      if (botToken) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
        } catch (err) {
          log.warn(
            { error: summarizeTelegramError(err) },
            'Failed to deregister Telegram webhook (proceeding with credential cleanup)',
          );
        }
      }

      deleteSecureKey('credential:telegram:bot_token');
      deleteCredentialMetadata('telegram', 'bot_token');
      deleteSecureKey('credential:telegram:webhook_secret');
      deleteCredentialMetadata('telegram', 'webhook_secret');

      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken: false,
        connected: false,
        hasWebhookSecret: false,
      });

      // Trigger reconcile to deregister webhook
      const effectiveUrl = getIngressPublicBaseUrl();
      if (effectiveUrl) {
        triggerGatewayReconcile(effectiveUrl);
      }
    } else if (msg.action === 'set_commands') {
      const storedToken = getSecureKey('credential:telegram:bot_token');
      if (!storedToken) {
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: false,
          connected: false,
          hasWebhookSecret: false,
          error: 'Bot token not configured. Run set action first.',
        });
        return;
      }

      const commands = msg.commands ?? [
        { command: 'new', description: 'Start a new conversation' },
        { command: 'help', description: 'Show available commands' },
        { command: 'guardian_verify', description: 'Verify your guardian identity' },
      ];

      try {
        const res = await fetch(`https://api.telegram.org/bot${storedToken}/setMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands }),
        });
        if (!res.ok) {
          const body = await res.text();
          ctx.send(socket, {
            type: 'telegram_config_response',
            success: false,
            hasBotToken: true,
            connected: !!getSecureKey('credential:telegram:webhook_secret'),
            hasWebhookSecret: !!getSecureKey('credential:telegram:webhook_secret'),
            error: `Failed to set bot commands: ${body}`,
          });
          return;
        }
      } catch (err) {
        const message = summarizeTelegramError(err);
        ctx.send(socket, {
          type: 'telegram_config_response',
          success: false,
          hasBotToken: true,
          connected: !!getSecureKey('credential:telegram:webhook_secret'),
          hasWebhookSecret: !!getSecureKey('credential:telegram:webhook_secret'),
          error: `Failed to set bot commands: ${message}`,
        });
        return;
      }

      const hasBotToken = !!getSecureKey('credential:telegram:bot_token');
      const hasWebhookSecret = !!getSecureKey('credential:telegram:webhook_secret');
      ctx.send(socket, {
        type: 'telegram_config_response',
        success: true,
        hasBotToken,
        connected: hasBotToken && hasWebhookSecret,
        hasWebhookSecret,
      });
    } else {
      ctx.send(socket, {
        type: 'telegram_config_response',
        success: false,
        hasBotToken: false,
        connected: false,
        hasWebhookSecret: false,
        error: `Unknown action: ${String((msg as unknown as Record<string, unknown>).action)}`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Failed to handle Telegram config');
    ctx.send(socket, {
      type: 'telegram_config_response',
      success: false,
      hasBotToken: false,
      connected: false,
      hasWebhookSecret: false,
      error: message,
    });
  }
}

export const telegramHandlers = defineHandlers({
  telegram_config: handleTelegramConfig,
});
