import { buildEmailTransportMetadata } from "../../channels/transport-hints.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { normalizeEmailWebhook } from "../../email/normalize.js";
import { verifyEmailWebhookSignature } from "../../email/verify.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import {
  resolveAssistant,
  isRejection,
} from "../../routing/resolve-assistant.js";
import {
  handleCircuitBreakerError,
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

    // Payload size guard
    const contentLength = req.headers.get("content-length");
    if (
      contentLength &&
      Number(contentLength) > config.maxWebhookPayloadBytes
    ) {
      tlog.warn({ contentLength }, "Email webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
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
        "Email webhook payload too large",
      );
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    // Resolve webhook secret from credential cache
    const webhookSecret = caches?.credentials
      ? await caches.credentials.get(credentialKey("vellum", "webhook_secret"))
      : undefined;

    // If the initial cache read returned undefined but a credential cache is available,
    // attempt one forced refresh before fail-closing — the credential may have been
    // written after the TTL cache was last populated.
    let effectiveSecret = webhookSecret;
    if (!effectiveSecret && caches?.credentials) {
      effectiveSecret = await caches.credentials.get(
        credentialKey("vellum", "webhook_secret"),
        { force: true },
      );
      if (effectiveSecret) {
        tlog.info(
          "Email webhook secret resolved after forced credential refresh",
        );
      }
    }

    // Signature validation is required — reject when no secret is configured
    // rather than silently accepting unauthenticated payloads (fail-closed).
    if (!effectiveSecret) {
      tlog.warn("Email webhook secret is not configured — rejecting request");
      return Response.json(
        { error: "Webhook secret not configured" },
        { status: 409 },
      );
    }

    let signatureValid = verifyEmailWebhookSignature(
      req.headers,
      rawBody,
      effectiveSecret,
    );

    // One-shot force retry: if verification failed and caches are available,
    // force-refresh the webhook secret and retry once.
    if (!signatureValid && caches?.credentials) {
      const freshSecret = await caches.credentials.get(
        credentialKey("vellum", "webhook_secret"),
        { force: true },
      );
      if (freshSecret) {
        signatureValid = verifyEmailWebhookSignature(
          req.headers,
          rawBody,
          freshSecret,
        );
        if (signatureValid) {
          tlog.info(
            "Email webhook signature verified after forced credential refresh",
          );
        }
      }
    }

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

    const { event, eventId, recipientAddress } = normalized;

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
        sourceMetadata: {
          emailSubject: (payload.subject as string | undefined) ?? undefined,
          emailRecipient: recipientAddress,
          ...(payload.inReplyTo ? { emailInReplyTo: payload.inReplyTo } : {}),
          ...(payload.references
            ? { emailReferences: payload.references }
            : {}),
        },
      });

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
        tlog.info(
          { status: "forwarded", eventId },
          "Email message forwarded to runtime",
        );
      }

      // Propagate the runtime's full response (including denied/reason/replyText)
      // so the platform can decide whether to persist the email and how to respond
      // to the sender.
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
