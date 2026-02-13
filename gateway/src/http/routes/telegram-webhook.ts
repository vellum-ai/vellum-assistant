import pino from "pino";
import type { GatewayConfig } from "../../config.js";
import type { GatewayInboundEventV1 } from "../../types.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";
import { downloadTelegramFile } from "../../telegram/download.js";
import { handleInbound, type InboundResult } from "../../handlers/handle-inbound.js";
import { resolveAssistant, isRejection } from "../../routing/resolve-assistant.js";
import { uploadAttachment } from "../../runtime/client.js";

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

    // Download and upload attachments if present
    let attachmentIds: string[] | undefined;
    const eventAttachments = normalized.message.attachments;
    if (eventAttachments && eventAttachments.length > 0) {
      const routing = resolveAssistant(
        config,
        normalized.message.externalChatId,
        normalized.sender.externalUserId,
      );

      if (!isRejection(routing)) {
        try {
          attachmentIds = [];
          for (const att of eventAttachments) {
            const downloaded = await downloadTelegramFile(config, att.fileId, {
              fileName: att.fileName,
              mimeType: att.mimeType,
            });
            const uploaded = await uploadAttachment(config, routing.assistantId, downloaded);
            attachmentIds.push(uploaded.id);
          }
        } catch (err) {
          log.error({ err }, "Failed to process attachments");
          return Response.json({ error: "Failed to process attachments" }, { status: 500 });
        }
      }
    }

    // Process inbound and only acknowledge after successful delivery
    let result: InboundResult;
    try {
      result = await handleInbound(config, normalized, { attachmentIds });
    } catch (err) {
      log.error({ err, updateId: payload.update_id }, "Failed to process inbound event");
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    if (!result.forwarded && !result.rejected) {
      log.error({ updateId: payload.update_id }, "Failed to forward inbound event");
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    // Fire reply asynchronously so webhook ack is not blocked by outbound send
    if (onReply && !result.rejected && result.runtimeResponse?.assistantMessage) {
      onReply(normalized.message.externalChatId, result).catch((err) => {
        log.error({ err, updateId: payload.update_id }, "Failed to send reply");
      });
    }

    return Response.json({ ok: true });
  };
}
