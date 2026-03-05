import { buildSmsTransportMetadata } from "../../channels/transport-hints.js";
import type { GatewayConfig } from "../../config.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { RejectionRateLimiter } from "../../rejection-rate-limiter.js";
import {
  resolveAssistant,
  resolveAssistantByPhoneNumber,
  isRejection,
} from "../../routing/resolve-assistant.js";
import type { RouteResult } from "../../routing/types.js";
import { sendSmsReply } from "../../twilio/send-sms.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";
import type { GatewayInboundEvent } from "../../types.js";
import { ROUTING_REJECTION_NOTICE } from "../../webhook-copy.js";
import {
  handleCircuitBreakerError,
  handleNewCommand,
  isNewCommand,
  processInboundResult,
} from "../../webhook-pipeline.js";

const log = getLogger("twilio-sms-webhook");

const rejectionLimiter = new RejectionRateLimiter();

function normalizeSmsPayload(
  params: Record<string, string>,
): GatewayInboundEvent {
  const body = params.Body || "";
  const from = params.From || "";
  const to = params.To || "";
  const messageSid = params.MessageSid || "";

  return {
    version: "v1",
    sourceChannel: "sms",
    receivedAt: new Date().toISOString(),
    message: {
      content: body,
      // Use From number as the chat identifier so per-phone-number conversations work
      conversationExternalId: from,
      externalMessageId: messageSid,
    },
    actor: {
      actorExternalId: from,
      displayName: from,
    },
    source: {
      updateId: messageSid,
      messageId: messageSid,
    },
    raw: { ...params, _to: to },
  };
}

export function createTwilioSmsWebhookHandler(config: GatewayConfig) {
  // 24-hour TTL — MessageSids are globally unique and never reused, so a
  // longer window hardens replay prevention beyond the default 5 minutes.
  const dedupCache = new StringDedupCache(24 * 60 * 60_000);

  const handler = async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    const validation = await validateTwilioWebhookRequest(req, config);
    if (validation instanceof Response) return validation;

    const { params } = validation;

    const messageSid = params.MessageSid;
    if (!messageSid) {
      tlog.warn("SMS webhook missing MessageSid");
      return Response.json({ error: "Missing MessageSid" }, { status: 400 });
    }

    // Dedup by MessageSid — atomically reserve the key so concurrent retries
    // are blocked even while the first request is still processing.
    // On failure, unreserve() allows Twilio retries; on success, mark() finalizes.
    if (!dedupCache.reserve(messageSid)) {
      tlog.info({ messageSid }, "Duplicate MessageSid, ignoring");
      return Response.json({ ok: true });
    }

    tlog.info(
      {
        source: "sms",
        messageSid,
        from: params.From,
        to: params.To,
      },
      "SMS webhook received",
    );

    // Phone-number routing takes priority, then fall through to standard routing.
    // We resolve once so gateway-originated replies (/new + MMS notices) can use
    // the correct assistant-scoped Twilio sender number.
    const routing =
      resolveAssistantByPhoneNumber(config, params.To || "") ??
      resolveAssistant(config, params.From || "", params.From || "");

    // --- MMS intercept: detect media attachments and reply with unsupported notice ---
    // Treat as MMS when NumMedia > 0, or when any MediaUrl/MediaContentType
    // fields are present (some Twilio configurations omit NumMedia).
    // The text body is still forwarded as a regular SMS so it isn't silently dropped.
    const numMedia = parseInt(params.NumMedia || "0", 10);
    const hasMediaFields = Object.keys(params).some(
      (key) =>
        (/^MediaUrl\d+$/.test(key) && params[key] !== "") ||
        (/^MediaContentType\d+$/.test(key) && params[key] !== ""),
    );
    if (numMedia > 0 || hasMediaFields) {
      tlog.info(
        { messageSid, numMedia, hasMediaFields },
        "MMS payload detected, replying with unsupported notice",
      );
      sendSmsReply(
        config,
        params.From,
        "MMS (images, video, and other media) is not supported yet. Please send a text-only message.",
        isRejection(routing) ? undefined : routing.assistantId,
      ).catch((err) => {
        tlog.error(
          { err, to: params.From },
          "Failed to send MMS unsupported notice",
        );
      });

      // If the MMS has no text body, we're done — nothing to forward.
      const mmsTextBody = (params.Body || "").trim();
      if (!mmsTextBody) {
        dedupCache.mark(messageSid);
        return Response.json({ ok: true });
      }

      // Fall through to process the text body as a regular message.
      tlog.info({ messageSid }, "MMS has text body, forwarding as SMS");
    }

    const normalized = normalizeSmsPayload(params);

    // --- /new intercept: reset conversation before it reaches the runtime ---
    if (isNewCommand(normalized.message.content)) {
      if (isRejection(routing)) {
        tlog.warn(
          { from: params.From, reason: routing.reason },
          "Routing rejected /new command",
        );
        sendSmsReply(config, params.From, ROUTING_REJECTION_NOTICE).catch(
          (err) => {
            tlog.error(
              { err, to: params.From },
              "Failed to send /new routing rejection notice",
            );
          },
        );
      } else {
        await handleNewCommand(
          config,
          normalized.sourceChannel,
          normalized.message.conversationExternalId,
          (text) =>
            sendSmsReply(config, params.From, text, routing.assistantId),
          tlog,
        );
      }

      dedupCache.mark(messageSid);
      return Response.json({ ok: true });
    }

    if (isRejection(routing)) {
      tlog.warn(
        { from: params.From, reason: routing.reason },
        "Routing rejected inbound SMS",
      );
      if (rejectionLimiter.shouldSend(params.From)) {
        sendSmsReply(config, params.From, ROUTING_REJECTION_NOTICE).catch(
          (err) => {
            tlog.error(
              { err, to: params.From },
              "Failed to send routing rejection notice",
            );
          },
        );
      }
      dedupCache.mark(messageSid);
      return Response.json({ ok: true });
    }

    try {
      const result = await handleInbound(config, normalized, {
        transportMetadata: buildSmsTransportMetadata(),
        replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/sms`,
        traceId,
        routingOverride: routing as RouteResult,
      });

      const outcome = processInboundResult(
        result,
        dedupCache,
        messageSid,
        () => {
          tlog.warn(
            { from: params.From, reason: result.rejectionReason },
            "Routing rejected inbound SMS",
          );
          if (rejectionLimiter.shouldSend(params.From)) {
            sendSmsReply(config, params.From, ROUTING_REJECTION_NOTICE).catch(
              (err) => {
                tlog.error(
                  { err, to: params.From },
                  "Failed to send routing rejection notice",
                );
              },
            );
          }
        },
        tlog,
      );

      if (!outcome.ok) {
        return Response.json(
          { error: "Internal error" },
          { status: outcome.status },
        );
      }

      dedupCache.mark(messageSid);
      if (!outcome.rejected) {
        tlog.info(
          { status: "forwarded", messageSid },
          "SMS forwarded to runtime",
        );
      }
    } catch (err) {
      const cbResponse = handleCircuitBreakerError(
        err,
        dedupCache,
        messageSid,
        tlog,
      );
      if (cbResponse) return cbResponse;

      tlog.error({ err, messageSid }, "Failed to process inbound SMS");
      dedupCache.unreserve(messageSid);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    return Response.json({ ok: true });
  };

  return { handler, dedupCache };
}
