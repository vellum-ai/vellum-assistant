import {
  ChannelPlugin,
  InboundAttachment,
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

export interface TelegramPhoto {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramGetFileResult {
  file_id: string;
  file_path?: string;
}

/**
 * Download a file from Telegram by file_id, returning base64 data.
 */
async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  hint?: { filename?: string; mimeType?: string },
): Promise<InboundAttachment | null> {
  try {
    const fileInfo = await callTelegramApi<TelegramGetFileResult>(
      botToken,
      "getFile",
      { file_id: fileId }
    );

    if (!fileInfo.file_path) return null;

    const fileUrl = `${TELEGRAM_API_BASE}/file/bot${botToken}/${fileInfo.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const contentType = response.headers.get("content-type")?.split(";")[0].trim();
    const mimeType = hint?.mimeType || contentType || "application/octet-stream";
    const filename = hint?.filename || fileInfo.file_path.split("/").pop()!;

    return { filename, mimeType, data: base64 };
  } catch (err) {
    console.error("[TG] Failed to download file:", err);
    return null;
  }
}

export async function downloadTelegramPhoto(
  botToken: string,
  photos: TelegramPhoto[]
): Promise<InboundAttachment | null> {
  const best = photos[photos.length - 1];
  if (!best) return null;
  return downloadTelegramFile(botToken, best.file_id);
}

export async function downloadTelegramDocument(
  botToken: string,
  doc: TelegramDocument
): Promise<InboundAttachment | null> {
  return downloadTelegramFile(botToken, doc.file_id, {
    filename: doc.file_name,
    mimeType: doc.mime_type,
  });
}

function parseTelegramInbound(payload: Record<string, unknown>): NormalizedInboundMessage | null {
  const message = payload.message as
    | {
        message_id?: number;
        text?: string;
        caption?: string;
        photo?: TelegramPhoto[];
        document?: TelegramDocument;
        chat?: { id?: number; type?: string };
        from?: { id?: number; username?: string; first_name?: string; last_name?: string };
      }
    | undefined;

  const updateId = payload.update_id as number | undefined;
  const hasText = Boolean(message?.text);
  const hasPhoto = Array.isArray(message?.photo) && message!.photo!.length > 0;
  const hasDocument = Boolean(message?.document?.file_id);

  if ((!hasText && !hasPhoto && !hasDocument) || !message?.chat?.id || !updateId) {
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

  // Use text for text messages, caption for photo messages.
  const text = message.text ?? message.caption ?? "";

  return {
    text,
    externalChatId: String(message.chat.id),
    externalMessageId: String(updateId),
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
    media: true,
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
        return false;
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
