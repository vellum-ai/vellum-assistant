import type { GatewayConfig } from "../../config.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { resolveAssistant, isRejection } from "../../routing/resolve-assistant.js";
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

    const normalized = normalizeSmsPayload(params);

    // Check routing
    const routing = resolveAssistant(
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
