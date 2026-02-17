import type { GatewayConfig } from "../../config.js";
import { DedupCache } from "../../dedup-cache.js";
import { handleInbound, type InboundResult } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { resolveAssistant, isRejection } from "../../routing/resolve-assistant.js";
import { AttachmentValidationError, resetConversation, uploadAttachment } from "../../runtime/client.js";
import { downloadTelegramFile } from "../../telegram/download.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";
import { sendTelegramReply, sendTypingIndicator } from "../../telegram/send.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";

const log = getLogger("telegram-webhook");

const MAX_TYPING_DURATION_MS = 60_000;
const MAX_TYPING_FAILURES = 3;
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

    // Dedup check — reserve the update_id immediately so concurrent retries
    // are blocked even while the first request is still processing.
    const updateId = typeof payload.update_id === "number" ? payload.update_id : undefined;
    if (updateId !== undefined) {
      const reserved = dedupCache.reserve(updateId);
      if (!reserved) {
        log.info({ updateId }, "Duplicate update_id, returning cached response");
        const cached = dedupCache.get(updateId)!;
        return new Response(cached.body, {
          status: cached.status,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // Helper: build a JSON response and update the cache with the final result
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

    // Edits don't produce a new reply, so skip typing indicator and attachments
    const isEdit = !!normalized.message.isEdit;

    // Check routing early so we can gate attachments and typing indicator
    const chatId = normalized.message.externalChatId;
    const routing = resolveAssistant(
      config,
      chatId,
      normalized.sender.externalUserId,
    );
    const routable = !isRejection(routing);

    // Download and upload attachments if present (skip for edits — the runtime
    // edit path only updates text content and doesn't link new attachments)
    let attachmentIds: string[] | undefined;
    const eventAttachments = normalized.message.attachments;
    if (eventAttachments && eventAttachments.length > 0 && routable && !isEdit) {
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

        // Process with bounded concurrency. Validation errors (unsupported
        // MIME type, dangerous extension) are skipped so that a bad attachment
        // doesn't drop the user's message. Transient errors (download timeout,
        // upload 5xx, network failures) are propagated so that Telegram retries
        // the webhook delivery.
        for (let i = 0; i < eligible.length; i += config.maxAttachmentConcurrency) {
          const batch = eligible.slice(i, i + config.maxAttachmentConcurrency);
          const results = await Promise.allSettled(
            batch.map(async (att) => {
              const downloaded = await downloadTelegramFile(config, att.fileId, {
                fileName: att.fileName,
                mimeType: att.mimeType,
              });
              return uploadAttachment(config, routing.assistantId, downloaded);
            }),
          );
          for (const result of results) {
            if (result.status === 'fulfilled') {
              attachmentIds.push(result.value.id);
            } else if (result.reason instanceof AttachmentValidationError) {
              log.warn({ err: result.reason }, "Skipping attachment with validation error");
            } else {
              // Transient failure — propagate so the webhook returns 500 and
              // Telegram retries the update delivery.
              throw result.reason;
            }
          }
        }
      } catch (err) {
        // Transient attachment failure — return 500 so Telegram retries.
        log.error({ err }, "Attachment processing failed with transient error");
        return respond({ error: "Attachment processing failed" }, 500);
      }
    }

    // Start typing indicator only for routable chats with new messages.
    // A safety timeout ensures the interval is cleared even if handleInbound hangs.
    // Cancel early if the Telegram API fails repeatedly (MAX_TYPING_FAILURES consecutive).
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let typingTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearTyping = () => {
      clearInterval(typingInterval);
      clearTimeout(typingTimeout);
    };
    if (routable && !isEdit) {
      let consecutiveFailures = 0;
      // Fire-and-forget: don't track the initial call's result to avoid
      // race conditions with the interval's consecutiveFailures counter.
      sendTypingIndicator(config, chatId);
      typingInterval = setInterval(async () => {
        const ok = await sendTypingIndicator(config, chatId);
        if (ok) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_TYPING_FAILURES) {
            log.warn({ chatId, consecutiveFailures }, "Typing indicator cancelled after repeated failures");
            clearTyping();
          }
        }
      }, 5000);
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
