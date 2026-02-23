import type { GatewayConfig } from "../../config.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { resolveAssistant, resolveAssistantByPhoneNumber, isRejection } from "../../routing/resolve-assistant.js";
import type { RouteResult } from "../../routing/types.js";
import { resetConversation } from "../../runtime/client.js";
import { sendSmsReply } from "../../twilio/send-sms.js";
import { validateTwilioWebhookRequest } from "../../twilio/validate-webhook.js";
import type { GatewayInboundEventV1 } from "../../types.js";

const log = getLogger("twilio-sms-webhook");

export const SMS_CHANNEL_TRANSPORT_HINTS = [
  "chat-first-medium",
  "channel-safe-onboarding",
  "defer-dashboard-only-tasks",
  "sms-character-limits",
] as const;
export const SMS_CHANNEL_TRANSPORT_UX_BRIEF =
  "SMS is text-only with carrier-imposed message length limits. Keep responses concise and defer rich-media tasks to desktop.";

export function buildSmsTransportMetadata(): { hints: string[]; uxBrief: string } {
  return {
    hints: [...SMS_CHANNEL_TRANSPORT_HINTS],
    uxBrief: SMS_CHANNEL_TRANSPORT_UX_BRIEF,
  };
}

function normalizeSmsPayload(
  params: Record<string, string>,
): Omit<GatewayInboundEventV1, "routing"> {
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
      externalChatId: from,
      externalMessageId: messageSid,
    },
    sender: {
      externalUserId: from,
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
  const dedupCache = new StringDedupCache();

  return async (req: Request): Promise<Response> => {
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

    // --- MMS intercept: detect media attachments and reply with unsupported notice ---
    // Treat as MMS when NumMedia > 0, or when any MediaUrl/MediaContentType
    // fields are present (some Twilio configurations omit NumMedia).
    const numMedia = parseInt(params.NumMedia || "0", 10);
    const hasMediaFields = Object.keys(params).some(
      (key) =>
        (/^MediaUrl\d+$/.test(key) && params[key] !== "") ||
        (/^MediaContentType\d+$/.test(key) && params[key] !== ""),
    );
    if (numMedia > 0 || hasMediaFields) {
      tlog.info({ messageSid, numMedia, hasMediaFields }, "MMS payload detected, replying with unsupported notice");
      sendSmsReply(config, params.From, "MMS (images, video, and other media) is not supported yet. Please send a text-only message.").catch(
        (err) => {
          tlog.error({ err, to: params.From }, "Failed to send MMS unsupported notice");
        },
      );
      dedupCache.mark(messageSid);
      return Response.json({ ok: true });
    }

    const normalized = normalizeSmsPayload(params);

    // --- /new intercept: reset conversation before it reaches the runtime ---
    if (normalized.message.content.trim().toLowerCase() === "/new") {
      // Phone-number routing takes priority: match the "To" number to an assistant
      const routing = resolveAssistantByPhoneNumber(config, params.To || "")
        ?? resolveAssistant(
          config,
          normalized.message.externalChatId,
          normalized.sender.externalUserId,
        );

      if (isRejection(routing)) {
        tlog.warn(
          { from: params.From, reason: routing.reason },
          "Routing rejected /new command",
        );
        sendSmsReply(
          config,
          params.From,
          "This message could not be routed to an assistant. Please check your gateway routing configuration.",
        ).catch((err) => {
          tlog.error({ err, to: params.From }, "Failed to send /new routing rejection notice");
        });
      } else {
        try {
          await resetConversation(
            config,
            routing.assistantId,
            normalized.sourceChannel,
            normalized.message.externalChatId,
          );
          sendSmsReply(config, params.From, "Starting a new conversation!").catch((err) => {
            tlog.error({ err }, "Failed to send /new confirmation");
          });
        } catch (err) {
          tlog.error({ err }, "Failed to reset conversation");
          sendSmsReply(config, params.From, "Failed to reset conversation. Please try again.").catch((replyErr) => {
            tlog.error({ err: replyErr }, "Failed to send /new error reply");
          });
        }
      }

      dedupCache.mark(messageSid);
      return Response.json({ ok: true });
    }

    // Phone-number routing takes priority, then fall through to standard routing
    const routing = resolveAssistantByPhoneNumber(config, params.To || "")
      ?? resolveAssistant(
        config,
        normalized.message.externalChatId,
        normalized.sender.externalUserId,
      );

    if (isRejection(routing)) {
      tlog.warn(
        { from: params.From, reason: routing.reason },
        "Routing rejected inbound SMS",
      );
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

      if (result.rejected) {
        tlog.warn(
          { from: params.From, reason: result.rejectionReason },
          "Routing rejected inbound SMS",
        );
        dedupCache.mark(messageSid);
        return Response.json({ ok: true });
      }

      if (!result.forwarded) {
        tlog.error({ messageSid }, "Failed to forward SMS to runtime");
        dedupCache.unreserve(messageSid);
        return Response.json({ error: "Internal error" }, { status: 500 });
      }

      // Mark as seen only after successful forwarding
      dedupCache.mark(messageSid);
      tlog.info({ status: "forwarded", messageSid }, "SMS forwarded to runtime");
    } catch (err) {
      tlog.error({ err, messageSid }, "Failed to process inbound SMS");
      dedupCache.unreserve(messageSid);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    return Response.json({ ok: true });
  };
}
