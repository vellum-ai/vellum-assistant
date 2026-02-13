import pino from "pino";
import type { GatewayConfig } from "../../config.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";
import { downloadTelegramFile } from "../../telegram/download.js";
import { handleInbound, type InboundResult } from "../../handlers/handle-inbound.js";
import { sendTypingIndicator } from "../../telegram/send.js";
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

    // Payload size guard
    const contentLength = req.headers.get("content-length");
    if (contentLength && Number(contentLength) > config.maxWebhookPayloadBytes) {
      log.warn({ contentLength }, "Webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    // Verify webhook secret
    if (!verifyWebhookSecret(req.headers, config.telegramWebhookSecret)) {
      log.warn("Telegram webhook request failed secret verification");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }

    if (Buffer.byteLength(rawBody) > config.maxWebhookPayloadBytes) {
      log.warn({ bodyLength: Buffer.byteLength(rawBody) }, "Webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
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

          // Filter oversized attachments
          const eligible = eventAttachments.filter((att) => {
            if (att.fileSize !== undefined && att.fileSize > config.maxAttachmentBytes) {
              log.warn(
                { fileId: att.fileId, fileSize: att.fileSize, limit: config.maxAttachmentBytes },
                "Skipping oversized attachment",
              );
              return false;
            }
            return true;
          });

          // Process with bounded concurrency
          for (let i = 0; i < eligible.length; i += config.maxAttachmentConcurrency) {
            const batch = eligible.slice(i, i + config.maxAttachmentConcurrency);
            const results = await Promise.all(
              batch.map(async (att) => {
                const downloaded = await downloadTelegramFile(config, att.fileId, {
                  fileName: att.fileName,
                  mimeType: att.mimeType,
                });
                return uploadAttachment(config, routing.assistantId, downloaded);
              }),
            );
            for (const uploaded of results) {
              attachmentIds.push(uploaded.id);
            }
          }
        } catch (err) {
          log.error({ err }, "Failed to process attachments");
          return Response.json({ error: "Failed to process attachments" }, { status: 500 });
        }
      }
    }

    // Start typing indicator
    const chatId = normalized.message.externalChatId;
    sendTypingIndicator(config, chatId);
    const typingInterval = setInterval(() => sendTypingIndicator(config, chatId), 5000);

    // Process inbound and only acknowledge after successful delivery
    let result: InboundResult;
    try {
      result = await handleInbound(config, normalized, { attachmentIds });
    } catch (err) {
      log.error({ err, updateId: payload.update_id }, "Failed to process inbound event");
      return Response.json({ error: "Internal error" }, { status: 500 });
    } finally {
      clearInterval(typingInterval);
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
