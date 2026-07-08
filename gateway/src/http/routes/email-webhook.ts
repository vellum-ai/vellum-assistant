import { buildEmailTransportMetadata } from "../../channels/transport-hints.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../../credential-refresh.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { normalizeEmailWebhook } from "../../email/normalize.js";
import { verifyEmailWebhookSignature } from "../../email/verify.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { readLimitedBody } from "../read-limited-body.js";
import {
  resolveAssistant,
  isRejection,
} from "../../routing/resolve-assistant.js";
import {
  handleCircuitBreakerError,
  interceptedReply,
  processInboundResult,
} from "../../webhook-pipeline.js";

const log = getLogger("email-webhook");

export function createEmailWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  // 24-hour TTL — Message-IDs are globally unique per RFC 5322
  const dedupCache = new StringDedupCache(24 * 60 * 60_000);

  const handler = async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Cap body buffering before the (unauthenticated) signature check; a
    // header-only guard is bypassable via chunked / absent Content-Length.
    const bodyResult = await readLimitedBody(
      req,
      config.maxWebhookPayloadBytes,
    );
    if (bodyResult.status === "too_large") {
      tlog.warn("Email webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    if (bodyResult.status === "unreadable") {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }
    const rawBody = bodyResult.text;

    // Signature validation is required — reject when no secret is configured
    // rather than silently accepting unauthenticated payloads (fail-closed).
    const webhookSecret = await resolveCredentialWithRefresh(
      caches?.credentials,
      credentialKey("vellum", "webhook_secret"),
    );
    if (!webhookSecret) {
      tlog.warn("Email webhook secret is not configured — rejecting request");
      return Response.json(
        { error: "Webhook secret not configured" },
        { status: 409 },
      );
    }

    const signatureValid = await verifySecretWithRefresh({
      credentials: caches?.credentials,
      key: credentialKey("vellum", "webhook_secret"),
      verify: (secret) =>
        verifyEmailWebhookSignature(req.headers, rawBody, secret),
      log: tlog,
      label: "Email webhook signature",
    });

    if (!signatureValid) {
      tlog.warn("Email webhook signature verification failed");
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Normalize the webhook payload
    const normalized = normalizeEmailWebhook(payload);
    if (!normalized) {
      // Missing required fields — log and acknowledge
      tlog.debug("Email webhook missing required fields, acknowledging");
      return Response.json({ ok: true });
    }

    const { event, eventId, recipientAddress, senderAuthenticated } =
      normalized;

    // Dedup by event ID
    if (!dedupCache.reserve(eventId)) {
      tlog.info({ eventId }, "Duplicate email event ID, ignoring");
      return Response.json({ ok: true });
    }

    tlog.info(
      {
        source: "email",
        eventId,
        from: event.actor.actorExternalId,
        to: recipientAddress,
        messageId: event.message.externalMessageId,
      },
      "Email webhook received",
    );

    // Resolve routing using the recipient address as both conversation
    // and actor ID — the standard routing chain will check explicit
    // routes first, then fall back to the default assistant.
    const routing = resolveAssistant(
      config,
      event.message.conversationExternalId,
      event.actor.actorExternalId,
    );

    if (isRejection(routing)) {
      tlog.warn(
        {
          from: event.actor.actorExternalId,
          to: recipientAddress,
          reason: routing.reason,
        },
        "Routing rejected inbound email",
      );
      // No way to reply to the sender for rejected emails — just log
      dedupCache.mark(eventId);
      return Response.json({ ok: true });
    }

    // Forward to runtime
    try {
      const inReplyTo =
        typeof payload.messageId === "string" ? payload.messageId : undefined;
      const subject =
        typeof payload.subject === "string" ? payload.subject : undefined;

      const result = await handleInbound(config, event, {
        transportMetadata: buildEmailTransportMetadata({
          senderAddress: event.actor.actorExternalId,
          recipientAddress: recipientAddress,
          subject,
          inReplyTo,
        }),
        replyCallbackUrl: undefined, // Email replies use `assistant email send` tool (no /deliver/email)
        traceId,
        routingOverride: routing,
        senderAuthenticated,
        sourceMetadata: {
          emailProvider: "platform",
          emailSubject: (payload.subject as string | undefined) ?? undefined,
          emailRecipient: recipientAddress,
          ...(typeof payload.inReplyTo === "string"
            ? { emailInReplyTo: payload.inReplyTo }
            : {}),
          ...(typeof payload.references === "string"
            ? { emailReferences: payload.references }
            : {}),
        },
      });

      // Verification / invite reply — short-circuit before processInboundResult
      const intercept = interceptedReply(result);
      if (intercept) {
        dedupCache.mark(eventId);
        tlog.info(
          { from: event.actor.actorExternalId, to: recipientAddress },
          "Gateway intercept — returning reply text to platform",
        );
        // replyText contract: the gateway cannot send email on this path — the
        // reply rides the HTTP response for the platform (vembda) to deliver,
        // and delivery is tracked platform-side.
        return Response.json({
          ok: true,
          [intercept.flag]: true,
          replyText: intercept.text,
        });
      }

      const processed = processInboundResult(
        result,
        dedupCache,
        eventId,
        () => {
          // No real-time reply mechanism for email — rejection is logged only
          tlog.warn(
            { from: event.actor.actorExternalId, to: recipientAddress },
            "Email routing rejected after forwarding attempt",
          );
        },
        tlog,
      );

      if (!processed.ok) {
        return Response.json({ error: "Internal error" }, { status: 500 });
      }

      dedupCache.mark(eventId);

      if (!result.rejected) {
        const denied = result.runtimeResponse?.denied ?? false;
        const deniedReason = denied
          ? (result.runtimeResponse?.reason ?? "unknown")
          : undefined;
        tlog.info(
          {
            status: denied ? "denied" : "forwarded",
            eventId,
            ...(denied && { deniedReason }),
          },
          denied
            ? "Email message denied by runtime"
            : "Email message forwarded to runtime",
        );
      }

      // Propagate the runtime's full response (including denied/reason/replyText)
      // so the platform can decide whether to persist the email and how to respond
      // to the sender. Same replyText contract as above: the gateway cannot send
      // email here — the platform (vembda) delivers any reply and tracks delivery.
      const runtimeBody = result.runtimeResponse ?? {};
      return Response.json({ ok: true, ...runtimeBody });
    } catch (err) {
      const cbResponse = handleCircuitBreakerError(
        err,
        dedupCache,
        eventId,
        tlog,
      );
      if (cbResponse) return cbResponse;

      tlog.error({ err, eventId }, "Failed to process inbound email");
      dedupCache.unreserve(eventId);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };

  return { handler, dedupCache };
}
