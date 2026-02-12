import pino from "pino";
import type { GatewayConfig } from "../../config.js";
import type { GatewayInboundEventV1 } from "../../types.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";
import { handleInbound, type InboundResult } from "../../handlers/handle-inbound.js";

const log = pino({ name: "gateway:telegram-webhook" });

export type OnReply = (
  chatId: string,
  result: InboundResult,
) => Promise<void>;

export function createTelegramWebhookHandler(
  config: GatewayConfig,
  onReply?: OnReply,
) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Verify webhook secret
    if (!verifyWebhookSecret(req.headers, config.telegramWebhookSecret)) {
      log.warn("Telegram webhook request failed secret verification");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Normalize the update
    const normalized = normalizeTelegramUpdate(payload);
    if (!normalized) {
      log.debug({ updateId: payload.update_id }, "Unsupported Telegram update, ignoring");
      return Response.json({ ok: true });
    }

    // Return 200 immediately, process async
    const processAsync = async () => {
      try {
        const result = await handleInbound(config, normalized);

        if (onReply && !result.rejected && result.runtimeResponse?.assistantMessage) {
          await onReply(normalized.message.externalChatId, result);
        }
      } catch (err) {
        log.error({ err, updateId: payload.update_id }, "Failed to process inbound event");
      }
    };

    processAsync();

    return Response.json({ ok: true });
  };
}
