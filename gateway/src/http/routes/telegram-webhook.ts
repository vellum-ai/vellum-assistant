import type { GatewayConfig } from "../../config.js";
import { DedupCache } from "../../dedup-cache.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { resolveAssistant, isRejection } from "../../routing/resolve-assistant.js";
import { AttachmentValidationError, resetConversation, uploadAttachment } from "../../runtime/client.js";
import { downloadTelegramFile } from "../../telegram/download.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";
import { sendTelegramReply } from "../../telegram/send.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";

const log = getLogger("telegram-webhook");

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

// Rate limiter for routing rejection notices — at most one reply per chat
// within the cooldown window to avoid spamming the user.
const REJECTION_NOTICE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_REJECTION_CACHE_SIZE = 10_000;
const SWEEP_INTERVAL = 100; // sweep every N calls
const rejectionNoticeTimestamps = new Map<string, number>();
let rejectionCallCount = 0;

/**
 * Evict expired entries from the rejection notice cache. If the map still
 * exceeds MAX_REJECTION_CACHE_SIZE after removing stale entries, drop the
 * oldest entries until it fits.
 */
function sweepRejectionCache(now: number): void {
  for (const [key, ts] of rejectionNoticeTimestamps) {
    if (now - ts >= REJECTION_NOTICE_COOLDOWN_MS) {
      rejectionNoticeTimestamps.delete(key);
    }
  }

  if (rejectionNoticeTimestamps.size > MAX_REJECTION_CACHE_SIZE) {
    // Sort by timestamp ascending and drop the oldest entries
    const sorted = [...rejectionNoticeTimestamps.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.length - MAX_REJECTION_CACHE_SIZE;
    for (let i = 0; i < toRemove; i++) {
      rejectionNoticeTimestamps.delete(sorted[i][0]);
    }
  }
}

function shouldSendRejectionNotice(chatId: string): boolean {
  const now = Date.now();

  // Periodically sweep expired entries to bound memory growth
  rejectionCallCount++;
  if (rejectionCallCount >= SWEEP_INTERVAL) {
    rejectionCallCount = 0;
    sweepRejectionCache(now);
  }

  const lastSent = rejectionNoticeTimestamps.get(chatId);
  if (lastSent !== undefined && now - lastSent < REJECTION_NOTICE_COOLDOWN_MS) {
    return false;
  }
  rejectionNoticeTimestamps.set(chatId, now);
  return true;
}

export function createTelegramWebhookHandler(config: GatewayConfig) {
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

    const isEdit = !!normalized.message.isEdit;

    // Check routing early so we can gate attachments
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
        // Use Response.json() instead of respond() to bypass the dedup cache,
        // otherwise the cached 500 prevents Telegram retries from being processed.
        log.error({ err }, "Attachment processing failed with transient error");
        if (updateId !== undefined) dedupCache.unreserve(updateId);
        return Response.json({ error: "Attachment processing failed" }, { status: 500 });
      }
    }

    // Forward message to the runtime. The runtime processes the message
    // in its own loop and delivers the reply to Telegram asynchronously.
    try {
      const result = await handleInbound(config, normalized, {
        attachmentIds,
        transportMetadata: buildTelegramTransportMetadata(),
        replyCallbackUrl: `http://127.0.0.1:${config.port}/deliver/telegram`,
      });

      if (result.rejected) {
        log.warn(
          { chatId, reason: result.rejectionReason },
          "Routing rejected inbound Telegram message",
        );
        if (shouldSendRejectionNotice(chatId)) {
          sendTelegramReply(
            config,
            chatId,
            "\u26a0\ufe0f This message could not be routed to an assistant. Please check your gateway routing configuration.",
          ).catch((err) => {
            log.error({ err, chatId }, "Failed to send routing rejection notice");
          });
        }
        return respond({ ok: true });
      }

      if (!result.forwarded) {
        log.error({ updateId: payload.update_id }, "Failed to forward inbound event");
        if (updateId !== undefined) dedupCache.unreserve(updateId);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }
    } catch (err) {
      log.error({ err, updateId: payload.update_id }, "Failed to process inbound event");
      if (updateId !== undefined) dedupCache.unreserve(updateId);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    return respond({ ok: true });
  };
}
