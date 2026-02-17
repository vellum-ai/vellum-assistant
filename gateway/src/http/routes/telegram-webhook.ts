import type { GatewayConfig } from "../../config.js";
import { DedupCache } from "../../dedup-cache.js";
import { handleInbound, type InboundResult } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { resolveAssistant, isRejection } from "../../routing/resolve-assistant.js";
import { resetConversation, uploadAttachment } from "../../runtime/client.js";
import { downloadTelegramFile } from "../../telegram/download.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";
import { sendTelegramReply, sendTypingIndicator } from "../../telegram/send.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";

const log = getLogger("telegram-webhook");

const MAX_TYPING_DURATION_MS = 60_000;
export const TELEGRAM_CHANNEL_TRANSPORT_HINTS = [
  "chat-first-medium",
  "channel-safe-onboarding",
  "defer-dashboard-only-tasks",
] as const;
export const TELEGRAM_CHANNEL_TRANSPORT_UX_BRIEF =
  "Telegram is chat-only. Complete channel-safe steps in-channel and defer dashboard-only Home Base tasks to desktop.";

export function buildTelegramTransportMetadata(): { hints: string[]; uxBrief: string } {
  return {
    hints: [...TELEGRAM_CHANNEL_TRANSPORT_HINTS],
    uxBrief: TELEGRAM_CHANNEL_TRANSPORT_UX_BRIEF,
  };
}

export type OnReply = (
  chatId: string,
  result: InboundResult,
  assistantId: string,
) => Promise<void>;

export function createTelegramWebhookHandler(
  config: GatewayConfig,
  onReply?: OnReply,
) {
  const dedupCache = new DedupCache();

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
    if (!config.telegramWebhookSecret || !verifyWebhookSecret(req.headers, config.telegramWebhookSecret)) {
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

    // Dedup check — short-circuit retried webhooks before doing any real work
    const updateId = typeof payload.update_id === "number" ? payload.update_id : undefined;
    if (updateId !== undefined) {
      const cached = dedupCache.get(updateId);
      if (cached) {
        log.info({ updateId }, "Duplicate update_id, returning cached response");
        return new Response(cached.body, {
          status: cached.status,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Helper: build a JSON response and cache it for this update_id
    const respond = (body: Record<string, unknown>, status = 200): Response => {
      const json = JSON.stringify(body);
      if (updateId !== undefined) {
        dedupCache.set(updateId, json, status);
      }
      return new Response(json, {
        status,
        headers: { "content-type": "application/json" },
      });
    };

    // Normalize the update
    const normalized = normalizeTelegramUpdate(payload);
    if (!normalized) {
      return respond({ ok: true });
    }

    // Handle /new command — reset conversation before it reaches the runtime
    if (normalized.message.content.trim() === "/new") {
      const routing = resolveAssistant(
        config,
        normalized.message.externalChatId,
        normalized.sender.externalUserId,
      );

      if (!isRejection(routing)) {
        try {
          await resetConversation(
            config,
            routing.assistantId,
            normalized.sourceChannel,
            normalized.message.externalChatId,
          );
          sendTelegramReply(config, normalized.message.externalChatId, "Starting a new conversation!").catch((err) => {
            log.error({ err }, "Failed to send /new confirmation");
          });
        } catch (err) {
          log.error({ err }, "Failed to reset conversation");
          sendTelegramReply(config, normalized.message.externalChatId, "Failed to reset conversation. Please try again.").catch((replyErr) => {
            log.error({ err: replyErr }, "Failed to send /new error reply");
          });
        }
      }

      return respond({ ok: true });
    }

    // Check routing early so we can gate attachments and typing indicator
    const chatId = normalized.message.externalChatId;
    const routing = resolveAssistant(
      config,
      chatId,
      normalized.sender.externalUserId,
    );
    const routable = !isRejection(routing);

    // Download and upload attachments if present
    let attachmentIds: string[] | undefined;
    const eventAttachments = normalized.message.attachments;
    if (eventAttachments && eventAttachments.length > 0 && routable) {
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

    // Start typing indicator only for routable chats.
    // A safety timeout ensures the interval is cleared even if handleInbound hangs.
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let typingTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearTyping = () => {
      clearInterval(typingInterval);
      clearTimeout(typingTimeout);
    };
    if (routable) {
      sendTypingIndicator(config, chatId);
      typingInterval = setInterval(() => sendTypingIndicator(config, chatId), 5000);
      typingTimeout = setTimeout(clearTyping, MAX_TYPING_DURATION_MS);
    }

    // Process inbound and only acknowledge after successful delivery
    let result: InboundResult;
    try {
      result = await handleInbound(config, normalized, {
        attachmentIds,
        transportMetadata: buildTelegramTransportMetadata(),
      });
    } catch (err) {
      log.error({ err, updateId: payload.update_id }, "Failed to process inbound event");
      return Response.json({ error: "Internal error" }, { status: 500 });
    } finally {
      clearTyping();
    }

    if (!result.forwarded && !result.rejected) {
      log.error({ updateId: payload.update_id }, "Failed to forward inbound event");
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    // Fire reply asynchronously so webhook ack is not blocked by outbound send
    if (onReply && !isRejection(routing) && !result.rejected && result.runtimeResponse?.assistantMessage) {
      onReply(normalized.message.externalChatId, result, routing.assistantId).catch((err) => {
        log.error({ err, updateId: payload.update_id }, "Failed to send reply");
      });
    }

    return respond({ ok: true });
  };
}
