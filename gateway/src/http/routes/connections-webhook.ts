import type { GatewayConfig } from "../../config.js";
import { normalizeConnectionsDelivery } from "../../connections/normalize.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../../credential-refresh.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { isFeatureFlagEnabled } from "../../feature-flag-resolver.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import {
  isRejection,
  resolveAssistant,
} from "../../routing/resolve-assistant.js";
import { upsertContactChannel } from "../../verification/contact-helpers.js";
import {
  handleCircuitBreakerError,
  interceptedReply,
  processInboundResult,
} from "../../webhook-pipeline.js";
import { readLimitedBody } from "../read-limited-body.js";
import {
  timestampWithinTolerance,
  verifyVellumSignature,
} from "../vellum-signature.js";

const log = getLogger("connections-webhook");

const CONNECTIONS_CHANNEL_FLAG = "connections-channel";

/**
 * `POST /webhooks/connections`: a message another Vellum user sent this
 * assistant from their own Vellum, delivered by the platform.
 *
 * The sender never authenticates to this assistant. The platform
 * authenticates them by their Vellum session and signs the body with this
 * assistant's webhook secret, the same `Vellum-Signature` scheme the platform
 * email webhook uses. From there the message takes the path every channel
 * takes: the sender is seeded as a contact, classified by the trust verdict,
 * and admitted or denied by the channel's floor.
 *
 * No reply callback is passed. Gateway intercept replies and the runtime's
 * deny text come back in this response for the platform to show the sender.
 */
export function createConnectionsWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache },
) {
  const dedupCache = new StringDedupCache(24 * 60 * 60_000);

  const handler = async (req: Request): Promise<Response> => {
    if (!isFeatureFlagEnabled(CONNECTIONS_CHANNEL_FLAG)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    const bodyResult = await readLimitedBody(
      req,
      config.maxWebhookPayloadBytes,
    );
    if (bodyResult.status === "too_large") {
      tlog.warn("Connections delivery too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    if (bodyResult.status === "unreadable") {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }
    const rawBody = bodyResult.text;

    const webhookSecret = await resolveCredentialWithRefresh(
      caches?.credentials,
      credentialKey("vellum", "webhook_secret"),
    );
    if (!webhookSecret) {
      tlog.warn("Webhook secret is not configured, rejecting delivery");
      return Response.json(
        { error: "Webhook secret not configured" },
        { status: 409 },
      );
    }

    const signatureValid = await verifySecretWithRefresh({
      credentials: caches?.credentials,
      key: credentialKey("vellum", "webhook_secret"),
      verify: (secret) => verifyVellumSignature(req.headers, rawBody, secret),
      log: tlog,
      label: "Connections delivery signature",
    });
    if (!signatureValid) {
      tlog.warn("Connections delivery signature verification failed");
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const normalized = normalizeConnectionsDelivery(payload);
    if (!normalized) {
      tlog.warn("Connections delivery missing required fields");
      return Response.json({ error: "Invalid delivery" }, { status: 400 });
    }
    const { event, eventId, issuedAt } = normalized;

    // The signature covers `issuedAt`, so a captured delivery replays only
    // inside this window; within it, the event id dedups here and in the
    // runtime's permanent inbound-event record.
    if (!timestampWithinTolerance(String(issuedAt))) {
      tlog.warn({ eventId, issuedAt }, "Connections delivery outside window");
      return Response.json({ error: "Stale delivery" }, { status: 403 });
    }

    if (!dedupCache.reserve(eventId)) {
      tlog.info({ eventId }, "Duplicate connections delivery, ignoring");
      return Response.json({ ok: true, duplicate: true });
    }

    const routing = resolveAssistant(
      config,
      event.message.conversationExternalId,
      event.actor.actorExternalId,
    );
    if (isRejection(routing)) {
      tlog.warn(
        { eventId, reason: routing.reason },
        "Routing rejected connections delivery",
      );
      dedupCache.unreserve(eventId);
      return Response.json(
        { error: "No assistant to deliver to" },
        { status: 422 },
      );
    }

    tlog.info(
      {
        source: "connections",
        eventId,
        threadId: event.message.conversationExternalId,
        sender: event.actor.actorExternalId,
      },
      "Connections delivery received",
    );

    // A thread is not the sender's delivery address, so no externalChatId.
    void upsertContactChannel({
      sourceChannel: "connections",
      externalUserId: event.actor.actorExternalId,
      displayName: event.actor.displayName,
      username: event.actor.username,
    }).catch(() => {});

    try {
      const result = await handleInbound(config, event, {
        traceId,
        routingOverride: routing,
        senderAuthenticated: true,
      });

      const intercept = interceptedReply(result);
      if (intercept) {
        dedupCache.mark(eventId);
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
          tlog.warn({ eventId }, "Connections delivery rejected after routing");
        },
        tlog,
      );
      if (!processed.ok) {
        return Response.json({ error: "Internal error" }, { status: 500 });
      }

      dedupCache.mark(eventId);
      return Response.json({ ok: true, ...(result.runtimeResponse ?? {}) });
    } catch (err) {
      const cbResponse = handleCircuitBreakerError(
        err,
        dedupCache,
        eventId,
        tlog,
      );
      if (cbResponse) {
        return cbResponse;
      }
      tlog.error({ err, eventId }, "Failed to process connections delivery");
      dedupCache.unreserve(eventId);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };

  return { handler, dedupCache };
}
