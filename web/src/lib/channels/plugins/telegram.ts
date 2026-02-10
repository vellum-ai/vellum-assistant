import {
  ChannelPlugin,
  NormalizedInboundMessage,
} from "@/lib/channels/plugins/types";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_LEN = 4000;

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramGetMeResult {
  id: number;
  username?: string;
}

function getApiUrl(token: string, method: string) {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(getApiUrl(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok || !data.result) {
    throw new Error(
      data.description
        ? `Telegram ${method} failed: ${data.description}`
        : `Telegram ${method} failed with status ${response.status}`
    );
  }

  return data.result;
}

function splitText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LEN) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + TELEGRAM_MAX_MESSAGE_LEN));
    cursor += TELEGRAM_MAX_MESSAGE_LEN;
  }
  return chunks;
}

function parseTelegramInbound(payload: Record<string, unknown>): NormalizedInboundMessage | null {
  const message = payload.message as
    | {
        message_id?: number;
        text?: string;
        chat?: { id?: number; type?: string };
        from?: { id?: number; username?: string; first_name?: string; last_name?: string };
      }
    | undefined;

  if (!message?.text || !message.chat?.id || !message.message_id) {
    return null;
  }

  // v1 is DM-only.
  if (message.chat.type !== "private") {
    return null;
  }

  const externalUserId = message.from?.id ? String(message.from.id) : String(message.chat.id);
  const displayName = [message.from?.first_name, message.from?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return {
    text: message.text,
    externalChatId: String(message.chat.id),
    externalMessageId: String(message.message_id),
    sender: {
      externalUserId,
      username: message.from?.username,
      displayName: displayName || undefined,
    },
    raw: payload,
  };
}

export const telegramPlugin: ChannelPlugin = {
  id: "telegram",
  meta: {
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
  },
  capabilities: {
    dm: true,
    groups: false,
    channels: false,
    media: false,
  },
  setup: {
    async connect(input) {
      const me = await callTelegramApi<TelegramGetMeResult>(input.botToken, "getMe", {});

      await callTelegramApi(
        input.botToken,
        "setWebhook",
      {
        url: input.webhookUrl,
        secret_token: input.webhookSecret,
        allowed_updates: ["message"],
      }
    );

      return {
        externalAccountId: String(me.id),
        username: me.username,
        config: {
          botToken: input.botToken,
          botId: me.id,
          botUsername: me.username ?? null,
          webhookSecret: input.webhookSecret ?? null,
          webhookUrl: input.webhookUrl,
          connectedAt: new Date().toISOString(),
        },
      };
    },
    async disconnect(input) {
      await callTelegramApi(input.botToken, "deleteWebhook", {
        drop_pending_updates: false,
      });
    },
  },
  inbound: {
    verifyWebhook(input) {
      if (!input.secret) {
        return true;
      }
      const provided = input.headers.get("x-telegram-bot-api-secret-token");
      return provided === input.secret;
    },
    normalizeMessage(payload) {
      return parseTelegramInbound(payload);
    },
  },
  outbound: {
    async sendText(input) {
      const chunks = splitText(input.text);
      for (const chunk of chunks) {
        await callTelegramApi(input.botToken, "sendMessage", {
          chat_id: input.chatId,
          text: chunk,
        });
      }
    },
  },
};
