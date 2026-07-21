import { buildTelegramTransportMetadata } from "../../channels/transport-hints.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { verifySecretWithRefresh } from "../../credential-refresh.js";
import { recordDenialReplyIfAllowed } from "../../db/denial-reply-rate-limiter.js";
import { DedupCache } from "../../dedup-cache.js";
import { ContentMismatchError } from "../../download-validation.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { readLimitedBody } from "../read-limited-body.js";
import { RejectionRateLimiter } from "../../rejection-rate-limiter.js";
import {
  resolveAssistant,
  isRejection,
} from "../../routing/resolve-assistant.js";
import {
  AttachmentValidationError,
  CircuitBreakerOpenError,
  createTelegramVerificationThread,
  uploadAttachment,
} from "../../runtime/client.js";
import { resolveGuardianDelivery } from "../../risk/guardian-delivery-resolver.js";
import { callTelegramApi } from "../../telegram/api.js";
import { downloadTelegramFile } from "../../telegram/download.js";
import {
  normalizeTelegramUpdate,
  isTelegramForumTopicEdited,
} from "../../telegram/normalize.js";
import { sendTelegramReply } from "../../telegram/send.js";
import {
  handleTelegramAccessCallback,
  handleTelegramAccessCommand,
  handleTelegramArchiveCommand,
  handleTelegramForkCommand,
  handleTelegramForumTopicEdited,
  handleTelegramHelpCommand,
  handleTelegramProfileCallback,
  handleTelegramProfileCommand,
  handleTelegramRenameCommand,
  handleTelegramStopCommand,
  parseTelegramAccessCallback,
  parseTelegramAccessCommand,
  parseTelegramArchiveCommand,
  parseTelegramForkCommand,
  parseTelegramHelpCommand,
  parseTelegramProfileCallback,
  parseTelegramProfileCommand,
  parseTelegramRenameCommand,
  parseTelegramStopCommand,
} from "../../telegram/topic-commands.js";
import {
  buildTelegramDeliverUrl,
  telegramSendOpts,
} from "../../telegram/topics.js";
import { verifyWebhookSecret } from "../../telegram/verify.js";
import { composeVerificationSuccessReply } from "../../verification/reply-delivery.js";
import {
  ROUTING_REJECTION_NOTICE,
  SERVICE_UNAVAILABLE_ERROR,
} from "../../webhook-copy.js";
import {
  handleNewCommand,
  interceptedReply,
  isNewCommand,
} from "../../webhook-pipeline.js";

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
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  const dedupCache = new DedupCache();

  // Verification topics this gateway created per chat (threaded mode). A
  // verified code only tears down the dedicated Verification topic recorded
  // here — never an ordinary assistant topic where a user happens to paste a
  // still-valid code. In-memory is sufficient: a gateway restart just skips the
  // best-effort teardown, which is safe.
  const VERIFICATION_TOPIC_TTL_MS = 30 * 60_000;
  const verificationTopics = new Map<
    string,
    { threadId: string; expiresAt: number }
  >();
  const rememberVerificationTopic = (
    chatId: string,
    threadId: string,
  ): void => {
    verificationTopics.set(chatId, {
      threadId,
      expiresAt: Date.now() + VERIFICATION_TOPIC_TTL_MS,
    });
  };
  const isVerificationTopic = (chatId: string, threadId: string): boolean => {
    const entry = verificationTopics.get(chatId);
    if (!entry) {
      return false;
    }
    if (Date.now() > entry.expiresAt) {
      verificationTopics.delete(chatId);
      return false;
    }
    return entry.threadId === threadId;
  };
  const forgetVerificationTopic = (chatId: string): void => {
    verificationTopics.delete(chatId);
  };

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

    const secretVerified = await verifySecretWithRefresh({
      credentials: caches?.credentials,
      key: credentialKey("telegram", "webhook_secret"),
      verify: (secret) => verifyWebhookSecret(req.headers, secret),
      log: tlog,
      label: "Telegram webhook secret",
    });

    if (!secretVerified) {
      tlog.warn("Telegram webhook request failed secret verification");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Cap body buffering on the streamed bytes — the header-only guard
    // above is bypassable via chunked / absent Content-Length.
    const bodyResult = await readLimitedBody(
      req,
      config.maxWebhookPayloadBytes,
    );
    if (bodyResult.status === "too_large") {
      tlog.warn("Telegram webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    if (bodyResult.status === "unreadable") {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }
    const rawBody = bodyResult.text;

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
        "answerCallbackQuery",
        {
          callback_query_id: callbackQueryId,
        },
        { credentials: caches?.credentials, configFile: caches?.configFile },
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

        callTelegramApi("deleteMessage", basePayload, {
          credentials: caches?.credentials,
          configFile: caches?.configFile,
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
        "editMessageReplyMarkup",
        {
          ...basePayload,
          reply_markup: null,
        },
        { credentials: caches?.credentials, configFile: caches?.configFile },
      ).catch((primaryErr) =>
        callTelegramApi(
          "editMessageReplyMarkup",
          {
            ...basePayload,
            reply_markup: { inline_keyboard: [] },
          },
          { credentials: caches?.credentials, configFile: caches?.configFile },
        ).catch((fallbackErr) => deleteApprovalPrompt(primaryErr, fallbackErr)),
      );
    };

    const isApprovalCallbackData = (
      callbackData: string | undefined,
    ): boolean => {
      if (!callbackData) return false;
      return callbackData.startsWith("apr:");
    };

    // Threaded mode: a verification code confirmed inside a dedicated
    // "Verification" topic. Delete the topic (removing the now-consumed code)
    // and re-post the success confirmation to the main chat so it survives the
    // topic removal.
    const closeVerificationTopic = async (
      chatId: string,
      threadId: string,
      trustClass: "guardian" | "trusted_contact" | undefined,
    ): Promise<void> => {
      const parsedThreadId = Number(threadId);
      if (!Number.isFinite(parsedThreadId)) return;
      const opts = {
        credentials: caches?.credentials,
        configFile: caches?.configFile,
      };
      // Await the topic deletion before confirming in the main chat so the
      // success reply can never land before the consumed code's topic is torn
      // down. Running them concurrently made message ordering unpredictable —
      // the "verified" confirmation could appear while the code was still
      // visible in a not-yet-deleted topic. A delete failure is logged but not
      // fatal: verification already succeeded, so the confirmation is still
      // sent.
      try {
        await callTelegramApi(
          "deleteForumTopic",
          { chat_id: chatId, message_thread_id: parsedThreadId },
          opts,
        );
      } catch (err) {
        tlog.error(
          { err, chatId, threadId },
          "Failed to delete Telegram verification topic",
        );
      }
      try {
        await sendTelegramReply(
          config,
          chatId,
          composeVerificationSuccessReply(trustClass),
          undefined,
          opts,
        );
      } catch (err) {
        tlog.error(
          { err, chatId },
          "Failed to send verification success confirmation to main chat",
        );
      }
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
        threadId: normalized.source.threadId,
      },
      "Webhook received",
    );

    const topicThreadId = normalized.source.threadId;
    const sendOpts = telegramSendOpts(caches, topicThreadId);

    if (isTelegramForumTopicEdited(normalized)) {
      await handleTelegramForumTopicEdited({
        config,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        title: normalized.message.content,
        logger: tlog,
      });
      return respond({ ok: true });
    }

    const profileCallback = parseTelegramProfileCallback(
      normalized.message.callbackData ?? normalized.message.content,
    );
    if (profileCallback && normalized.message.callbackQueryId) {
      await handleTelegramProfileCallback({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        messageId: normalized.source.messageId,
        profile: profileCallback.profile,
        logger: tlog,
      });
      acknowledgeCallbackQuery(
        normalized.message.callbackQueryId,
        "profile_callback",
      );
      return respond({ ok: true });
    }

    const accessCallback = parseTelegramAccessCallback(
      normalized.message.callbackData ?? normalized.message.content,
    );
    if (accessCallback && normalized.message.callbackQueryId) {
      await handleTelegramAccessCallback({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        messageId: normalized.source.messageId,
        actorExternalId: normalized.actor.actorExternalId,
        threshold: accessCallback.threshold,
        logger: tlog,
      });
      acknowledgeCallbackQuery(
        normalized.message.callbackQueryId,
        "access_callback",
      );
      return respond({ ok: true });
    }

    if (parseTelegramForkCommand(normalized.message.content)) {
      await handleTelegramForkCommand({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        logger: tlog,
      });
      return respond({ ok: true });
    }

    if (parseTelegramArchiveCommand(normalized.message.content)) {
      await handleTelegramArchiveCommand({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        logger: tlog,
      });
      return respond({ ok: true });
    }

    if (parseTelegramStopCommand(normalized.message.content)) {
      await handleTelegramStopCommand({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        logger: tlog,
      });
      return respond({ ok: true });
    }

    const renameCmd = parseTelegramRenameCommand(normalized.message.content);
    if (renameCmd !== null) {
      await handleTelegramRenameCommand({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        actorExternalId: normalized.actor.actorExternalId,
        name: renameCmd.name,
        logger: tlog,
      });
      return respond({ ok: true });
    }

    if (parseTelegramProfileCommand(normalized.message.content)) {
      await handleTelegramProfileCommand({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        logger: tlog,
      });
      return respond({ ok: true });
    }

    if (parseTelegramAccessCommand(normalized.message.content)) {
      await handleTelegramAccessCommand({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        actorExternalId: normalized.actor.actorExternalId,
        logger: tlog,
      });
      return respond({ ok: true });
    }

    if (parseTelegramHelpCommand(normalized.message.content)) {
      await handleTelegramHelpCommand({
        config,
        caches,
        chatId: normalized.message.conversationExternalId,
        threadId: topicThreadId,
        logger: tlog,
      });
      return respond({ ok: true });
    }

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
            sendOpts,
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

      // A bare /start from someone who is not yet a Telegram guardian
      // bootstraps guardian verification. In threaded mode, run that whole
      // exchange (ack + verification prompts + code entry) inside a dedicated
      // Verification bot thread so it stays out of the main chat. Falls back to
      // the main chat when threaded mode is off or thread creation fails.
      let startThreadId = topicThreadId;
      if (
        !normalized.message.callbackQueryId &&
        !startCmd.payload &&
        !topicThreadId &&
        resolveGuardianDelivery({ channelTypes: ["telegram"] }).length === 0
      ) {
        startThreadId =
          (await createTelegramVerificationThread(
            config,
            normalized.message.conversationExternalId,
          ).catch((err) => {
            tlog.warn(
              { err, chatId: normalized.message.conversationExternalId },
              "Failed to create Telegram verification thread for /start",
            );
            return undefined;
          })) ?? topicThreadId;
        if (startThreadId) {
          rememberVerificationTopic(
            normalized.message.conversationExternalId,
            startThreadId,
          );
        }
      }
      const startSendOpts = telegramSendOpts(caches, startThreadId);

      // Forward to runtime with command-intent metadata so the assistant
      // generates a natural greeting via the normal agent loop.
      // Skip the ACK when the /start includes a payload (e.g. invite token) —
      // the runtime will send its own contextual reply during ACL enforcement.
      if (!normalized.message.callbackQueryId && !startCmd.payload) {
        sendTelegramReply(
          config,
          normalized.message.conversationExternalId,
          START_COMMAND_ACK_TEXT,
          undefined,
          startSendOpts,
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
          replyCallbackUrl: buildTelegramDeliverUrl(
            config.gatewayInternalBaseUrl,
            startThreadId,
          ),
          deliverInterceptRepliesViaCaller: true,
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
              sendOpts,
            ).catch((err) => {
              tlog.error(
                { err, chatId: normalized.message.conversationExternalId },
                "Failed to send /start rejection notice",
              );
            });
          }
        } else if (result.verificationIntercepted || result.inviteIntercepted) {
          // Verification/invite handled at the gateway — send its reply
          // directly (the gateway owns Telegram outbound delivery).
          const reply = interceptedReply(result);
          if (reply) {
            sendTelegramReply(
              config,
              normalized.message.conversationExternalId,
              reply.text,
              undefined,
              sendOpts,
            ).catch((err) => {
              tlog.error(
                { err, chatId: normalized.message.conversationExternalId },
                "Failed to send /start intercept reply",
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
            sendOpts,
          ).catch((err) => {
            tlog.error({ err }, "Failed to send /start fallback reply");
          });
        } else {
          tlog.info({ status: "forwarded" }, "Forwarded /start to runtime");

          // Fallback: if the runtime denied the message and could not
          // deliver the rejection reply via callback, send it directly.
          const startRuntimeResp = result.runtimeResponse;
          if (startRuntimeResp?.denied && startRuntimeResp.replyText) {
            const startSender =
              normalized.actor.actorExternalId ??
              normalized.message.conversationExternalId;
            if (recordDenialReplyIfAllowed("telegram", startSender)) {
              sendTelegramReply(
                config,
                normalized.message.conversationExternalId,
                startRuntimeResp.replyText,
                undefined,
                sendOpts,
              ).catch((err) => {
                tlog.error(
                  { err, chatId: normalized.message.conversationExternalId },
                  "Failed to send ACL denial fallback reply",
                );
              });
            } else {
              tlog.info(
                { chatId: normalized.message.conversationExternalId },
                "Denial reply rate-limited, skipping Telegram send",
              );
            }
          }
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
          sendOpts,
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
            sendOpts,
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
              sendOpts,
            );
          },
          tlog,
          topicThreadId,
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
    const failedAttachmentNames: string[] = [];
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
            att.fileSize >
              (config.maxAttachmentBytes.telegram ??
                config.maxAttachmentBytes.default)
          ) {
            tlog.warn(
              {
                fileId: att.fileId,
                fileSize: att.fileSize,
                limit:
                  config.maxAttachmentBytes.telegram ??
                  config.maxAttachmentBytes.default,
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
                att.fileId,
                {
                  fileName: att.fileName,
                  mimeType: att.mimeType,
                },
                sendOpts,
              );
              return uploadAttachment(config, downloaded);
            }),
          );
          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === "fulfilled") {
              attachmentIds.push(result.value.id);
            } else if (result.reason instanceof AttachmentValidationError) {
              tlog.warn(
                { err: result.reason },
                "Skipping attachment with validation error",
              );
              failedAttachmentNames.push(batch[j].fileName || batch[j].fileId);
            } else if (result.reason instanceof ContentMismatchError) {
              tlog.warn(
                { err: result.reason },
                "Skipping attachment with content mismatch",
              );
              failedAttachmentNames.push(batch[j].fileName || batch[j].fileId);
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

    // Inject context about failed attachments into the message
    if (failedAttachmentNames.length > 0) {
      const failureNotice = `[The user attached file(s) that could not be retrieved: ${failedAttachmentNames.map((n) => `"${n}"`).join(", ")}. Ask them to re-send if the content is important.]`;
      if (normalized.message.content.length > 0) {
        normalized.message.content += `\n\n${failureNotice}`;
      } else {
        normalized.message.content = failureNotice;
      }
    }

    // Forward message to the runtime. The runtime processes the message
    // in its own loop and delivers the reply to Telegram asynchronously.
    try {
      const result = await handleInbound(config, normalized, {
        attachmentIds,
        transportMetadata: buildTelegramTransportMetadata(),
        replyCallbackUrl: buildTelegramDeliverUrl(
          config.gatewayInternalBaseUrl,
          topicThreadId,
        ),
        deliverInterceptRepliesViaCaller: true,
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
            sendOpts,
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

      if (result.verificationIntercepted || result.inviteIntercepted) {
        if (
          result.verificationIntercepted &&
          result.verificationOutcome === "verified" &&
          topicThreadId &&
          isVerificationTopic(chatId, topicThreadId)
        ) {
          // Threaded verification: the code was confirmed inside the dedicated
          // Verification topic this gateway created, so delete that topic and
          // confirm in the main chat. Fire-and-forget — the helper sequences
          // delete-then-reply and handles its own errors, so the webhook
          // response is not blocked. A code entered in any other topic falls to
          // the branch below (reply in place, no deletion).
          forgetVerificationTopic(chatId);
          void closeVerificationTopic(
            chatId,
            topicThreadId,
            result.verificationTrustClass,
          );
        } else {
          // Normal mode (or a failure): the gateway owns Telegram outbound —
          // there is no /deliver/telegram endpoint — so send the intercept
          // reply directly on the channel.
          const reply = interceptedReply(result);
          if (reply) {
            sendTelegramReply(
              config,
              chatId,
              reply.text,
              undefined,
              sendOpts,
            ).catch((err) => {
              tlog.error(
                { err, chatId },
                "Failed to send verification/invite intercept reply",
              );
            });
          }
        }
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

      // Fallback: if the runtime denied the message and could not
      // deliver the rejection reply via callback, send it directly.
      const runtimeResp = result.runtimeResponse;
      if (runtimeResp?.denied && runtimeResp.replyText) {
        const msgSender = normalized.actor.actorExternalId ?? chatId;
        if (recordDenialReplyIfAllowed("telegram", msgSender)) {
          sendTelegramReply(
            config,
            chatId,
            runtimeResp.replyText,
            undefined,
            sendOpts,
          ).catch((err) => {
            tlog.error(
              { err, chatId },
              "Failed to send ACL denial fallback reply",
            );
          });
        } else {
          tlog.info(
            { chatId },
            "Denial reply rate-limited, skipping Telegram send",
          );
        }
      }

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
