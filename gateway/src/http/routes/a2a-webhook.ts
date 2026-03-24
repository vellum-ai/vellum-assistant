import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";

import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { loadFeatureFlagDefaults } from "../../feature-flag-defaults.js";
import { readPersistedFeatureFlags } from "../../feature-flag-store.js";
import { getLogger } from "../../logger.js";
import { forwardToRuntime } from "../../runtime/client.js";
import {
  parseA2AEnvelope,
  A2AValidationError,
} from "../../../../assistant/src/runtime/a2a/message-contract.js";
import type {
  A2AEnvelope,
  A2AMessageEnvelope,
  A2APairingRequest,
  A2APairingAccepted,
  A2APairingFinalize,
} from "../../../../assistant/src/runtime/a2a/message-contract.js";

const log = getLogger("a2a-webhook");

const A2A_FLAG_KEY = "feature_flags.assistant-a2a.enabled";

function isA2AEnabled(): boolean {
  const persisted = readPersistedFeatureFlags();
  if (A2A_FLAG_KEY in persisted) return persisted[A2A_FLAG_KEY]!;
  const defaults = loadFeatureFlagDefaults();
  const def = defaults[A2A_FLAG_KEY];
  return def ? def.defaultEnabled : false;
}

/**
 * Constant-time string comparison to prevent timing attacks on token validation.
 */
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

export function createA2AWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache },
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    // Feature flag gate
    if (!isA2AEnabled()) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Content-type check
    const contentType = req.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return Response.json(
        { error: "Content-Type must be application/json" },
        { status: 415 },
      );
    }

    // Payload size guard
    const contentLength = req.headers.get("content-length");
    if (
      contentLength &&
      Number(contentLength) > config.maxWebhookPayloadBytes
    ) {
      tlog.warn({ contentLength }, "A2A webhook payload too large");
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
        "A2A webhook payload too large",
      );
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Parse and validate envelope
    let envelope: A2AEnvelope;
    try {
      envelope = parseA2AEnvelope(payload);
    } catch (err) {
      if (err instanceof A2AValidationError) {
        tlog.warn({ err: err.message }, "A2A envelope validation failed");
        return Response.json(
          { error: `Invalid envelope: ${err.message}` },
          { status: 400 },
        );
      }
      throw err;
    }

    // Auth handling by envelope type
    const { type, senderAssistantId } = envelope;

    if (type === "message" || type === "pairing_finalize") {
      // Require Bearer token auth
      const token = extractBearerToken(req);
      if (!token) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      // Resolve expected inbound token from credential store
      const expectedToken = caches?.credentials
        ? await caches.credentials.get(`a2a:inbound:${senderAssistantId}`)
        : undefined;

      if (!expectedToken) {
        tlog.warn({ senderAssistantId }, "No inbound token found for sender");
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      if (!constantTimeCompare(token, expectedToken)) {
        tlog.warn({ senderAssistantId }, "A2A Bearer token mismatch");
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
    // pairing_request and pairing_accepted: no auth required

    // Build RuntimeInboundPayload
    const authenticated = type === "message" || type === "pairing_finalize";

    // Derive content based on envelope type
    let content: string;
    let externalMessageId: string;
    let senderGatewayUrl: string | undefined;

    if (type === "message") {
      const msgEnv = envelope as A2AMessageEnvelope;
      content = msgEnv.content;
      externalMessageId = msgEnv.messageId;
    } else if (type === "pairing_request") {
      const prEnv = envelope as A2APairingRequest;
      content = JSON.stringify({
        type: prEnv.type,
        senderAssistantId: prEnv.senderAssistantId,
        senderGatewayUrl: prEnv.senderGatewayUrl,
        inviteCode: prEnv.inviteCode,
      });
      externalMessageId = randomUUID();
      senderGatewayUrl = prEnv.senderGatewayUrl;
    } else if (type === "pairing_accepted") {
      const paEnv = envelope as A2APairingAccepted;
      content = JSON.stringify({
        type: paEnv.type,
        senderAssistantId: paEnv.senderAssistantId,
        inviteCode: paEnv.inviteCode,
        inboundToken: paEnv.inboundToken,
      });
      externalMessageId = randomUUID();
    } else {
      // pairing_finalize
      const pfEnv = envelope as A2APairingFinalize;
      content = JSON.stringify({
        type: pfEnv.type,
        senderAssistantId: pfEnv.senderAssistantId,
        inviteCode: pfEnv.inviteCode,
        inboundToken: pfEnv.inboundToken,
      });
      externalMessageId = randomUUID();
    }

    // For authenticated messages, resolve senderGatewayUrl from stored contact metadata
    if (type === "message" && caches?.credentials) {
      senderGatewayUrl = await caches.credentials.get(
        `a2a:gateway:${senderAssistantId}`,
      );
    }

    // For pairing_accepted, senderGatewayUrl may not be available — the
    // pairing_accepted envelope doesn't include it. We can try to resolve
    // from stored contact metadata.
    if (type === "pairing_accepted" && caches?.credentials) {
      senderGatewayUrl = await caches.credentials.get(
        `a2a:gateway:${senderAssistantId}`,
      );
    }

    // For pairing_finalize, resolve from stored contact metadata
    if (type === "pairing_finalize" && caches?.credentials) {
      senderGatewayUrl = await caches.credentials.get(
        `a2a:gateway:${senderAssistantId}`,
      );
    }

    // Build replyCallbackUrl — only include if we have senderGatewayUrl
    const replyCallbackUrl = senderGatewayUrl
      ? `${config.gatewayInternalBaseUrl}/deliver/a2a?gatewayUrl=${encodeURIComponent(senderGatewayUrl)}&assistantId=${encodeURIComponent(senderAssistantId)}`
      : undefined;

    const sourceMetadata: Record<string, unknown> = {
      a2a: true,
      envelopeType: type,
      authenticated,
    };

    tlog.info(
      {
        source: "a2a",
        senderAssistantId,
        envelopeType: type,
        authenticated,
      },
      "A2A webhook received",
    );

    try {
      await forwardToRuntime(
        config,
        {
          sourceChannel: "vellum",
          interface: "vellum",
          // Server-derived conversationExternalId prevents routing hijack
          conversationExternalId: senderAssistantId,
          externalMessageId,
          content,
          actorExternalId: senderAssistantId,
          sourceMetadata,
          ...(replyCallbackUrl ? { replyCallbackUrl } : {}),
        },
        { traceId },
      );

      return Response.json({ ok: true });
    } catch (err) {
      tlog.error(
        { err, senderAssistantId },
        "Failed to forward A2A webhook to runtime",
      );
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };
}
