import { buildTelegramTransportMetadata } from "../../channels/transport-hints.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { DedupCache } from "../../dedup-cache.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { RejectionRateLimiter } from "../../rejection-rate-limiter.js";
import {
  resolveAssistant,
  isRejection,
} from "../../routing/resolve-assistant.js";
import {
  AttachmentValidationError,
  CircuitBreakerOpenError,
  uploadAttachment,
} from "../../runtime/client.js";
import { callTelegramApi } from "../../telegram/api.js";
import { downloadTelegramFile } from "../../telegram/download.js";
import { normalizeTelegramUpdate } from "../../telegram/normalize.js";
import { sendTelegramReply } from "../../telegram/send.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";
import {
  ROUTING_REJECTION_NOTICE,
  SERVICE_UNAVAILABLE_ERROR,
} from "../../webhook-copy.js";
import { handleNewCommand, isNewCommand } from "../../webhook-pipeline.js";

const log = getLogger("telegram-webhook");

/**
 * Parse `/start` or `/start <payload>` from Telegram message content.
 * Returns null if the message is not a /start command.
 */
export function parseTelegramStartCommand(
  content: string,
): { payload?: string } | null {
  const trimmed = content.trim();
  if (/^\/start$/i.test(trimmed)) return {};
  const match = trimmed.match(/^\/start\s+(.+)$/i);
  if (match) return { payload: match[1].trim() };
  return null;
}

const rejectionLimiter = new RejectionRateLimiter();
const START_COMMAND_ACK_TEXT =
  "Starting up... you'll get my first message in a moment.";

export function createTelegramWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache },
) {
  const dedupCache = new DedupCache();

  const handler = async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Payload size guard
    const contentLength = req.headers.get("content-length");
    if (
      contentLength &&
      Number(contentLength) > config.maxWebhookPayloadBytes
    ) {
      tlog.warn({ contentLength }, "Webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    // Verify webhook secret from cache
    const webhookSecret = caches?.credentials
      ? await caches.credentials.get("credential:telegram:webhook_secret")
      : undefined;

    let secretVerified =
      !!webhookSecret && verifyWebhookSecret(req.headers, webhookSecret);

    // One-shot force retry: if verification failed and caches are available,
    // force-refresh the webhook secret and retry once.
    if (!secretVerified && caches?.credentials) {
      const freshSecret = await caches.credentials.get(
        "credential:telegram:webhook_secret",
        { force: true },
      );
      if (freshSecret) {
        secretVerified = verifyWebhookSecret(req.headers, freshSecret);
        if (secretVerified) {
          tlog.info(
            "Telegram webhook secret verified after forced credential refresh",
          );
        }
      }
    }

    if (!secretVerified) {
      tlog.warn("Telegram webhook request failed secret verification");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }

    if (Buffer.byteLength(rawBody) > config.maxWebhookPayloadBytes) {
      tlog.warn(
        { bodyLength: Buffer.byteLength(rawBody) },
        "Webhook payload too large",
      );
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
    const updateId =
      typeof payload.update_id === "number" ? payload.update_id : undefined;
    if (updateId !== undefined) {
      const status = dedupCache.reserve(updateId);
      if (status !== "reserved") {
        if (status === "already_processed") {
          // High-water mark rejection — this update_id was fully processed
          // previously but the TTL entry has expired. Return idempotent success
          // so Telegram stops retrying.
          tlog.info(
            { updateId },
            "Update_id below high-water mark, returning idempotent success",
          );
          return Response.json({ ok: true }, { status: 200 });
        }
        // status === "duplicate" — entry is in the cache (in-flight or finalized)
        const cached = dedupCache.get(updateId);
        if (cached) {
          tlog.info(
            { updateId },
            "Duplicate update_id, returning cached response",
          );
          return new Response(cached.body, {
            status: cached.status,
            headers: { "content-type": "application/json" },
          });
        }
        // Still being processed by the first handler — ask Telegram to retry
        tlog.info(
          { updateId },
          "Duplicate update_id while still processing, returning 503",
        );
        return new Response(
          JSON.stringify({ error: "Processing in progress" }),
          {
            status: 503,
            headers: { "content-type": "application/json", "Retry-After": "1" },
          },
        );
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

    const acknowledgeCallbackQuery = (
      callbackQueryId: string | undefined,
      phase: string,
    ): void => {
      if (!callbackQueryId) return;
      callTelegramApi(
        config,
        "answerCallbackQuery",
        {
          callback_query_id: callbackQueryId,
        },
        { credentials: caches?.credentials },
      ).catch((err) => {
        tlog.error(
          { err, callbackQueryId, phase },
          "Failed to acknowledge callback query",
        );
      });
    };

    const clearInlineApprovalButtons = (
      chatId: string,
      messageId: string | undefined,
      phase: string,
    ): void => {
      if (!messageId) return;
      const parsedMessageId = Number(messageId);
      if (!Number.isFinite(parsedMessageId)) {
        tlog.warn(
          { messageId, phase },
          "Skipping inline approval button clear due to invalid message id",
        );
        return;
      }
      const basePayload = {
        chat_id: chatId,
        message_id: parsedMessageId,
      };
      const isNoOpMarkupError = (err: unknown): boolean => {
        const msg = err instanceof Error ? err.message : String(err);
        return msg.includes("message is not modified");
      };

      const deleteApprovalPrompt = (
        primaryErr: unknown,
        fallbackErr: unknown,
      ): void => {
        // "message is not modified" means the inline keyboard was already
        // removed (e.g. duplicate/stale callback clicks). The prompt is still
        // valid — skip the delete so we don't remove audit-worthy messages.
        if (isNoOpMarkupError(primaryErr) || isNoOpMarkupError(fallbackErr)) {
          tlog.info(
            { chatId, messageId: parsedMessageId, phase },
            "Inline keyboard already cleared (no-op edit); skipping message delete",
          );
          return;
        }

        callTelegramApi(config, "deleteMessage", basePayload, {
          credentials: caches?.credentials,
        }).catch((deleteErr) => {
          tlog.error(
            {
              primaryErr,
              fallbackErr,
              deleteErr,
              chatId,
              messageId: parsedMessageId,
              phase,
            },
            "Failed to clear inline approval buttons and delete prompt message",
          );
        });
      };

      // Bot API behavior differs across wrappers/clients for "remove markup".
      // Try the explicit null form first, then fall back to an empty inline
      // keyboard payload if needed. If both fail, delete the prompt message
      // so users are not left with stale actionable buttons — unless the error
      // indicates the markup was already removed (no-op).
      callTelegramApi(
        config,
        "editMessageReplyMarkup",
        {
          ...basePayload,
          reply_markup: null,
        },
        { credentials: caches?.credentials },
      ).catch((primaryErr) =>
        callTelegramApi(
          config,
          "editMessageReplyMarkup",
          {
            ...basePayload,
            reply_markup: { inline_keyboard: [] },
          },
          { credentials: caches?.credentials },
        ).catch((fallbackErr) => deleteApprovalPrompt(primaryErr, fallbackErr)),
      );
    };

    const isApprovalCallbackData = (
      callbackData: string | undefined,
    ): boolean => {
      if (!callbackData) return false;
      return callbackData.startsWith("apr:");
    };

    // Normalize the update
    const normalized = normalizeTelegramUpdate(payload);
    if (!normalized) {
      // If the dropped update was a callback query, acknowledge it so the
      // Telegram button spinner clears (e.g. non-DM callback queries).
      const cbqId =
        payload.callback_query &&
        typeof payload.callback_query === "object" &&
        "id" in (payload.callback_query as Record<string, unknown>)
          ? String((payload.callback_query as Record<string, unknown>).id)
          : undefined;
      acknowledgeCallbackQuery(cbqId, "dropped_update");
      return respond({ ok: true });
    }

    tlog.info(
      {
        source: "telegram",
        chatId: normalized.message.conversationExternalId,
        messageId: normalized.message.externalMessageId,
        updateId,
      },
      "Webhook received",
    );

    // Handle /start command — forward to runtime as a channel command intent
    const startCmd = parseTelegramStartCommand(normalized.message.content);
    if (startCmd !== null) {
      const startRouting = resolveAssistant(
        config,
        normalized.message.conversationExternalId,
        normalized.actor.actorExternalId,
      );

      if (isRejection(startRouting)) {
        tlog.warn(
          {
            chatId: normalized.message.conversationExternalId,
            reason: startRouting.reason,
          },
          "Routing rejected /start command",
        );
        if (
          rejectionLimiter.shouldSend(normalized.message.conversationExternalId)
        ) {
          sendTelegramReply(
            config,
            normalized.message.conversationExternalId,
            "\u26a0\ufe0f This bot is not fully set up yet. Please check the gateway configuration.",
            undefined,
            { credentials: caches?.credentials },
          ).catch((err) => {
            tlog.error(
              { err, chatId: normalized.message.conversationExternalId },
              "Failed to send /start routing rejection notice",
            );
          });
        }
        acknowledgeCallbackQuery(
          normalized.message.callbackQueryId,
          "start_command_routing_rejected",
        );
        return respond({ ok: true });
      }

      // Forward to runtime with command-intent metadata so the assistant
      // generates a natural greeting via the normal agent loop.
      if (!normalized.message.callbackQueryId) {
        sendTelegramReply(
          config,
          normalized.message.conversationExternalId,
          START_COMMAND_ACK_TEXT,
          undefined,
          { credentials: caches?.credentials },
        ).catch((err) => {
          tlog.error(
            { err, chatId: normalized.message.conversationExternalId },
            "Failed to send /start acknowledgement",
          );
        });
      }

      try {
        const result = await handleInbound(config, normalized, {
          transportMetadata: buildTelegramTransportMetadata(),
          replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/telegram`,
          traceId,
          sourceMetadata: {
            commandIntent: {
              type: "start",
              ...(startCmd.payload ? { payload: startCmd.payload } : {}),
            },
            languageCode: normalized.actor.languageCode,
          },
        });

        if (result.rejected) {
          tlog.warn(
            {
              chatId: normalized.message.conversationExternalId,
              reason: result.rejectionReason,
            },
            "Routing rejected /start forward",
          );
          if (
            rejectionLimiter.shouldSend(
              normalized.message.conversationExternalId,
            )
          ) {
            sendTelegramReply(
              config,
              normalized.message.conversationExternalId,
              "\u26a0\ufe0f This bot is not fully set up yet. Please check the gateway configuration.",
              undefined,
              { credentials: caches?.credentials },
            ).catch((err) => {
              tlog.error(
                { err, chatId: normalized.message.conversationExternalId },
                "Failed to send /start rejection notice",
              );
            });
          }
        } else if (!result.forwarded) {
          tlog.error(
            { updateId: payload.update_id },
            "Failed to forward /start to runtime",
          );
          sendTelegramReply(
            config,
            normalized.message.conversationExternalId,
            "Welcome! I'm having a brief setup hiccup. Please try again in a moment.",
            undefined,
            { credentials: caches?.credentials },
          ).catch((err) => {
            tlog.error({ err }, "Failed to send /start fallback reply");
          });
        } else {
          tlog.info({ status: "forwarded" }, "Forwarded /start to runtime");
        }
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) {
          acknowledgeCallbackQuery(
            normalized.message.callbackQueryId,
            "start_command_circuit_open",
          );
          if (updateId !== undefined) dedupCache.unreserve(updateId);
          return Response.json(
            { error: SERVICE_UNAVAILABLE_ERROR },
            {
              status: 503,
              headers: { "Retry-After": String(err.retryAfterSecs) },
            },
          );
        }
        tlog.error(
          { err, updateId: payload.update_id },
          "Failed to process /start command",
        );
        sendTelegramReply(
          config,
          normalized.message.conversationExternalId,
          "Welcome! I'm having a brief setup hiccup. Please try again in a moment.",
          undefined,
          { credentials: caches?.credentials },
        ).catch((replyErr) => {
          tlog.error({ err: replyErr }, "Failed to send /start error fallback");
        });
      }

      acknowledgeCallbackQuery(
        normalized.message.callbackQueryId,
        "start_command",
      );
      return respond({ ok: true });
    }

    // Handle /new command — reset conversation before it reaches the runtime
    if (isNewCommand(normalized.message.content)) {
      const routing = resolveAssistant(
        config,
        normalized.message.conversationExternalId,
        normalized.actor.actorExternalId,
      );

      if (isRejection(routing)) {
        tlog.warn(
          {
            chatId: normalized.message.conversationExternalId,
            reason: routing.reason,
          },
          "Routing rejected /new command",
        );
        if (
          rejectionLimiter.shouldSend(normalized.message.conversationExternalId)
        ) {
          sendTelegramReply(
            config,
            normalized.message.conversationExternalId,
            `\u26a0\ufe0f ${ROUTING_REJECTION_NOTICE}`,
            undefined,
            { credentials: caches?.credentials },
          ).catch((err) => {
            tlog.error(
              { err, chatId: normalized.message.conversationExternalId },
              "Failed to send /new routing rejection notice",
            );
          });
        }
      } else {
        await handleNewCommand(
          config,
          normalized.sourceChannel,
          normalized.message.conversationExternalId,
          async (text) => {
            await sendTelegramReply(
              config,
              normalized.message.conversationExternalId,
              text,
              undefined,
              { credentials: caches?.credentials },
            );
          },
          tlog,
        );
      }

      // Acknowledge callback query so the button spinner clears
      acknowledgeCallbackQuery(
        normalized.message.callbackQueryId,
        "new_command",
      );

      return respond({ ok: true });
    }

    const isEdit = !!normalized.message.isEdit;
    const isCallback = !!normalized.message.callbackQueryId;

    // Check routing early so we can gate attachments
    const chatId = normalized.message.conversationExternalId;
    const routing = resolveAssistant(
      config,
      chatId,
      normalized.actor.actorExternalId,
    );
    const routable = !isRejection(routing);

    // Download and upload attachments if present (skip for edits and callback
    // queries — edits only update text, callbacks have no media to process)
    let attachmentIds: string[] | undefined;
    const eventAttachments = normalized.message.attachments;
    if (
      eventAttachments &&
      eventAttachments.length > 0 &&
      routable &&
      !isEdit &&
      !isCallback
    ) {
      try {
        attachmentIds = [];

        // Filter oversized attachments
        const eligible = eventAttachments.filter((att) => {
          if (
            att.fileSize !== undefined &&
            att.fileSize > config.maxAttachmentBytes
          ) {
            tlog.warn(
              {
                fileId: att.fileId,
                fileSize: att.fileSize,
                limit: config.maxAttachmentBytes,
              },
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
        for (
          let i = 0;
          i < eligible.length;
          i += config.maxAttachmentConcurrency
        ) {
          const batch = eligible.slice(i, i + config.maxAttachmentConcurrency);
          const results = await Promise.allSettled(
            batch.map(async (att) => {
              const downloaded = await downloadTelegramFile(
                config,
                att.fileId,
                {
                  fileName: att.fileName,
                  mimeType: att.mimeType,
                },
                { credentials: caches?.credentials },
              );
              return uploadAttachment(config, downloaded);
            }),
          );
          for (const result of results) {
            if (result.status === "fulfilled") {
              attachmentIds.push(result.value.id);
            } else if (result.reason instanceof AttachmentValidationError) {
              tlog.warn(
                { err: result.reason },
                "Skipping attachment with validation error",
              );
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
        tlog.error(
          { err },
          "Attachment processing failed with transient error",
        );
        if (updateId !== undefined) dedupCache.unreserve(updateId);
        return Response.json(
          { error: "Attachment processing failed" },
          { status: 500 },
        );
      }
    }

    // Forward message to the runtime. The runtime processes the message
    // in its own loop and delivers the reply to Telegram asynchronously.
    try {
      const result = await handleInbound(config, normalized, {
        attachmentIds,
        transportMetadata: buildTelegramTransportMetadata(),
        replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/telegram`,
        traceId,
      });

      if (result.rejected) {
        tlog.warn(
          { chatId, reason: result.rejectionReason },
          "Routing rejected inbound Telegram message",
        );
        if (rejectionLimiter.shouldSend(chatId)) {
          sendTelegramReply(
            config,
            chatId,
            `\u26a0\ufe0f ${ROUTING_REJECTION_NOTICE}`,
            undefined,
            { credentials: caches?.credentials },
          ).catch((err) => {
            tlog.error(
              { err, chatId },
              "Failed to send routing rejection notice",
            );
          });
        }
        // Acknowledge rejected callback queries so the button spinner clears
        if (isCallback)
          acknowledgeCallbackQuery(
            normalized.message.callbackQueryId,
            "routing_rejected",
          );
        return respond({ ok: true });
      }

      if (!result.forwarded) {
        tlog.error(
          { updateId: payload.update_id },
          "Failed to forward inbound event",
        );
        if (isCallback)
          acknowledgeCallbackQuery(
            normalized.message.callbackQueryId,
            "forward_not_forwarded",
          );
        if (updateId !== undefined) dedupCache.unreserve(updateId);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }

      tlog.info({ status: "forwarded" }, "Forwarded to runtime");

      // Acknowledge the callback query to clear the button spinner in the
      // Telegram client. Best-effort — log errors but don't fail the flow.
      if (isCallback)
        acknowledgeCallbackQuery(
          normalized.message.callbackQueryId,
          "forwarded",
        );

      // Once a callback decision is consumed, remove the inline keyboard so
      // users cannot click obsolete approval buttons again.
      const approval = result.runtimeResponse?.approval;
      const consumedApprovalDecision =
        approval === "decision_applied" ||
        approval === "guardian_decision_applied" ||
        approval === "stale_ignored";
      const fallbackApprovalCallback =
        approval === undefined &&
        isApprovalCallbackData(normalized.message.callbackData);
      const shouldClearInlineButtons =
        consumedApprovalDecision || fallbackApprovalCallback;
      if (isCallback && shouldClearInlineButtons) {
        clearInlineApprovalButtons(
          normalized.message.conversationExternalId,
          normalized.source.messageId,
          approval ?? "callback_data_fallback",
        );
      }
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        tlog.warn(
          { retryAfterSecs: err.retryAfterSecs },
          "Circuit breaker open — returning 503",
        );
        if (isCallback)
          acknowledgeCallbackQuery(
            normalized.message.callbackQueryId,
            "circuit_open",
          );
        if (updateId !== undefined) dedupCache.unreserve(updateId);
        return Response.json(
          { error: SERVICE_UNAVAILABLE_ERROR },
          {
            status: 503,
            headers: { "Retry-After": String(err.retryAfterSecs) },
          },
        );
      }
      tlog.error(
        { err, updateId: payload.update_id },
        "Failed to process inbound event",
      );
      if (isCallback)
        acknowledgeCallbackQuery(
          normalized.message.callbackQueryId,
          "forward_exception",
        );
      if (updateId !== undefined) dedupCache.unreserve(updateId);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    return respond({ ok: true });
  };

  return { handler, dedupCache };
}
