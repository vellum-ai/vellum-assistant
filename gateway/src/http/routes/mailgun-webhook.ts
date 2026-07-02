import { createHmac, timingSafeEqual } from "node:crypto";
import { buildEmailTransportMetadata } from "../../channels/transport-hints.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import {
  resolveCredentialWithRefresh,
  verifySecretWithRefresh,
} from "../../credential-refresh.js";
import { recordDenialReplyIfAllowed } from "../../db/denial-reply-rate-limiter.js";
import { StringDedupCache } from "../../dedup-cache.js";
import type { VellumEmailPayload } from "../../email/normalize.js";
import { normalizeEmailWebhook } from "../../email/normalize.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { readLimitedBodyBytes } from "../read-limited-body.js";
import {
  resolveAssistant,
  isRejection,
} from "../../routing/resolve-assistant.js";
import {
  handleCircuitBreakerError,
  processInboundResult,
} from "../../webhook-pipeline.js";

const log = getLogger("mailgun-webhook");

/**
 * Maximum age (in seconds) for the timestamp before we reject the
 * webhook as too old. Mailgun docs recommend a generous tolerance
 * since external delays can occur.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 10 * 60;

// ── Mailgun HMAC signature verification ─────────────────────────────

/**
 * Verify a Mailgun webhook signature.
 *
 * Mailgun signs webhooks with HMAC-SHA256:
 *   HMAC-SHA256(signingKey, timestamp + token) → hex digest
 *
 * The `timestamp`, `token`, and `signature` are sent as fields in the
 * POST body (either as form fields or JSON properties).
 */
function verifyMailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
  signature: string,
): boolean {
  if (!timestamp || !token || !signature) return false;

  // Reject stale timestamps to prevent replay attacks
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", signingKey)
    .update(timestamp + token, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

// ── Mailgun inbound payload parsing ─────────────────────────────────

/**
 * Parse an RFC 5322 address like `"Alice <alice@example.com>"` into its
 * components. Returns the raw email address and optional display name.
 */
function parseEmailAddress(raw: string): {
  address: string;
  displayName?: string;
} {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, "");
    return { address: match[2].trim(), displayName: name || undefined };
  }
  return { address: raw.trim() };
}

/**
 * Parse form-encoded or JSON body into a flat field map. Takes already-read
 * bytes (size-capped upstream) and the content-type rather than the live
 * request, so the body is never buffered a second time and the payload cap is
 * enforced before parsing. Bytes are re-wrapped in a `Response` to reuse the
 * platform's multipart/form parser without losing binary fidelity.
 */
async function parseMailgunBody(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
): Promise<Record<string, string> | null> {
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const formData = await new Response(bytes, {
        headers: { "content-type": contentType },
      }).formData();
      const fields: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        if (typeof value === "string") {
          fields[key] = value;
        }
      }
      return fields;
    } catch {
      return null;
    }
  }

  if (contentType.includes("application/json")) {
    try {
      const json = (await new Response(bytes).json()) as Record<
        string,
        unknown
      >;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(json)) {
        if (typeof value === "string") {
          fields[key] = value;
        }
      }
      return fields;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Normalize Mailgun inbound fields into a `VellumEmailPayload`.
 */
function normalizeMailgunToVellumPayload(
  fields: Record<string, string>,
): VellumEmailPayload | null {
  const fromRaw = fields["from"] ?? fields["sender"];
  const recipient = fields["recipient"];
  const messageId = fields["Message-Id"];

  if (!fromRaw || !recipient || !messageId) return null;

  const parsed = parseEmailAddress(fromRaw);

  const inReplyTo = fields["In-Reply-To"] || undefined;
  const references = fields["References"] || undefined;

  // Derive a stable conversation ID using the root of the References
  // chain (first entry = thread root Message-ID per RFC 5322).
  // Falls back to recipient for new threads.
  const referencesRoot = references?.trim().split(/\s+/)[0];
  const conversationId = referencesRoot ?? recipient;

  // Prefer stripped-text (latest reply only); fall back to body-plain,
  // then body-html for HTML-only emails
  const strippedText = fields["stripped-text"] || undefined;
  const bodyText = fields["body-plain"] || fields["body-html"] || undefined;

  return {
    from: parsed.address,
    fromName: parsed.displayName,
    to: recipient,
    subject: fields["subject"],
    strippedText,
    bodyText,
    messageId,
    inReplyTo,
    references,
    conversationId,
    timestamp: fields["timestamp"],
  };
}

// ── Webhook handler factory ─────────────────────────────────────────

export function createMailgunWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
  // 24-hour TTL — Mailgun token is unique per webhook delivery
  const dedupCache = new StringDedupCache(24 * 60 * 60_000);

  const handler = async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Cap body buffering before the (unauthenticated) signature check; a
    // header-only guard is bypassable via chunked / absent Content-Length.
    const bodyResult = await readLimitedBodyBytes(
      req,
      config.maxWebhookPayloadBytes,
    );
    if (bodyResult.status === "too_large") {
      tlog.warn("Mailgun webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    if (bodyResult.status === "unreadable") {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }

    // ── Parse body ──────────────────────────────────────────────────
    // Mailgun inbound routes POST form-encoded data, not JSON.

    const fields = await parseMailgunBody(
      bodyResult.bytes,
      req.headers.get("content-type") ?? "",
    );
    if (!fields) {
      return Response.json({ error: "Failed to parse body" }, { status: 400 });
    }

    // ── Credential resolution ───────────────────────────────────────

    const signingKey = await resolveCredentialWithRefresh(
      caches?.credentials,
      credentialKey("mailgun", "webhook_signing_key"),
    );

    if (!signingKey) {
      tlog.warn(
        "Mailgun webhook signing key not configured — rejecting request",
      );
      return Response.json(
        { error: "Webhook signing key not configured" },
        { status: 409 },
      );
    }

    // ── Signature verification ──────────────────────────────────────

    const timestamp = fields["timestamp"] ?? "";
    const token = fields["token"] ?? "";
    const signature = fields["signature"] ?? "";

    const signatureValid = await verifySecretWithRefresh({
      credentials: caches?.credentials,
      key: credentialKey("mailgun", "webhook_signing_key"),
      verify: (key) => verifyMailgunSignature(key, timestamp, token, signature),
      log: tlog,
      label: "Mailgun webhook signature",
    });

    if (!signatureValid) {
      tlog.warn("Mailgun webhook signature verification failed");
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Dedup by token ──────────────────────────────────────────────
    // Mailgun's `token` field is unique per delivery — use it for dedup
    // as recommended by their docs for replay attack prevention.

    if (token && !dedupCache.reserve(token)) {
      tlog.info({ token }, "Duplicate Mailgun webhook token, ignoring");
      return Response.json({ ok: true });
    }

    // ── Normalize ───────────────────────────────────────────────────

    const vellumPayload = normalizeMailgunToVellumPayload(fields);
    if (!vellumPayload) {
      tlog.debug("Mailgun webhook missing required fields, acknowledging");
      if (token) dedupCache.mark(token);
      return Response.json({ ok: true });
    }

    const normalized = normalizeEmailWebhook(
      vellumPayload as unknown as Record<string, unknown>,
    );
    if (!normalized) {
      tlog.debug(
        "normalizeEmailWebhook returned null for Mailgun event, acknowledging",
      );
      if (token) dedupCache.mark(token);
      return Response.json({ ok: true });
    }

    const { event: gatewayEvent, eventId, recipientAddress } = normalized;

    tlog.info(
      {
        source: "mailgun",
        eventId,
        from: gatewayEvent.actor.actorExternalId,
        to: recipientAddress,
      },
      "Mailgun webhook received",
    );

    // ── Routing ─────────────────────────────────────────────────────

    const routing = resolveAssistant(
      config,
      gatewayEvent.message.conversationExternalId,
      gatewayEvent.actor.actorExternalId,
    );

    if (isRejection(routing)) {
      tlog.warn(
        {
          from: gatewayEvent.actor.actorExternalId,
          to: recipientAddress,
          reason: routing.reason,
        },
        "Routing rejected inbound Mailgun email",
      );
      if (token) dedupCache.mark(token);
      return Response.json({ ok: true });
    }

    // ── Forward to runtime ──────────────────────────────────────────

    try {
      const result = await handleInbound(config, gatewayEvent, {
        transportMetadata: buildEmailTransportMetadata({
          senderAddress: gatewayEvent.actor.actorExternalId,
          recipientAddress,
          subject: vellumPayload.subject,
          inReplyTo: vellumPayload.inReplyTo,
        }),
        replyCallbackUrl: undefined,
        traceId,
        routingOverride: routing,
        sourceMetadata: {
          emailSubject: vellumPayload.subject ?? undefined,
          emailRecipient: recipientAddress,
          ...(vellumPayload.inReplyTo
            ? { emailInReplyTo: vellumPayload.inReplyTo }
            : {}),
          ...(vellumPayload.references
            ? { emailReferences: vellumPayload.references }
            : {}),
        },
      });

      const processed = processInboundResult(
        result,
        dedupCache,
        token,
        () => {
          tlog.warn(
            { from: gatewayEvent.actor.actorExternalId, to: recipientAddress },
            "Mailgun email routing rejected after forwarding attempt",
          );
        },
        tlog,
      );

      if (!processed.ok) {
        return Response.json({ error: "Internal error" }, { status: 500 });
      }

      // ── Verification reply ──────────────────────────────────────
      // Not gated by recordDenialReplyIfAllowed — verification success
      // confirmations must always be delivered regardless of prior denial
      // replies to this sender.
      if (result.verificationIntercepted && result.verificationReplyText) {
        const mailgunApiKeyForVerify = await resolveCredentialWithRefresh(
          caches?.credentials,
          credentialKey("mailgun", "api_key"),
        );
        if (mailgunApiKeyForVerify) {
          const senderAddress = gatewayEvent.actor.actorExternalId;
          const mailgunDomainForVerify = recipientAddress.split("@")[1];
          if (mailgunDomainForVerify) {
            try {
              const form = new URLSearchParams();
              form.set("from", recipientAddress);
              form.set("to", senderAddress);
              form.set(
                "subject",
                `Re: ${vellumPayload.subject ?? "(no subject)"}`,
              );
              form.set("text", result.verificationReplyText);
              if (vellumPayload.messageId) {
                form.set("h:In-Reply-To", vellumPayload.messageId);
              }

              const sendResponse = await fetch(
                `https://api.mailgun.net/v3/${mailgunDomainForVerify}/messages`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Basic ${Buffer.from(`api:${mailgunApiKeyForVerify}`).toString("base64")}`,
                  },
                  body: form,
                },
              );
              if (sendResponse.ok) {
                tlog.info(
                  { from: recipientAddress, to: senderAddress },
                  "Sent verification reply via Mailgun",
                );
              } else {
                tlog.warn(
                  {
                    status: sendResponse.status,
                    from: recipientAddress,
                    to: senderAddress,
                  },
                  "Failed to send verification reply via Mailgun",
                );
              }
            } catch (err) {
              tlog.error(
                { err, from: recipientAddress, to: senderAddress },
                "Error sending verification reply via Mailgun",
              );
            }
          }
        }
        dedupCache.mark(token);
        return Response.json({ ok: true, verificationIntercepted: true });
      }

      dedupCache.mark(token);

      if (!result.rejected) {
        tlog.info(
          { status: "forwarded", eventId },
          "Mailgun email message forwarded to runtime",
        );
      }

      // ── Denial reply ────────────────────────────────────────────
      // When the runtime denies the message (ACL rejection) and provides
      // replyText, send a reply email so the unknown sender knows why
      // their message was rejected. The runtime can't send email directly
      // (no replyCallbackUrl for email), so the gateway handles it.
      const runtimeBody = result.runtimeResponse ?? {};
      if (result.runtimeResponse?.denied && result.runtimeResponse.replyText) {
        const mailgunApiKey = await resolveCredentialWithRefresh(
          caches?.credentials,
          credentialKey("mailgun", "api_key"),
        );
        if (mailgunApiKey) {
          const senderAddress = gatewayEvent.actor.actorExternalId;
          const mailgunDomain = recipientAddress.split("@")[1];
          if (mailgunDomain) {
            if (recordDenialReplyIfAllowed("email", senderAddress)) {
              try {
                const form = new URLSearchParams();
                form.set("from", recipientAddress);
                form.set("to", senderAddress);
                form.set(
                  "subject",
                  `Re: ${vellumPayload.subject ?? "(no subject)"}`,
                );
                form.set("text", result.runtimeResponse.replyText);
                if (vellumPayload.messageId) {
                  form.set("h:In-Reply-To", vellumPayload.messageId);
                }

                const sendResponse = await fetch(
                  `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Basic ${Buffer.from(`api:${mailgunApiKey}`).toString("base64")}`,
                    },
                    body: form,
                  },
                );
                if (sendResponse.ok) {
                  tlog.info(
                    { from: recipientAddress, to: senderAddress },
                    "Sent denial reply via Mailgun",
                  );
                } else {
                  tlog.warn(
                    {
                      status: sendResponse.status,
                      from: recipientAddress,
                      to: senderAddress,
                    },
                    "Failed to send denial reply via Mailgun",
                  );
                }
              } catch (err) {
                tlog.error(
                  { err, from: recipientAddress, to: senderAddress },
                  "Error sending denial reply via Mailgun",
                );
              }
            } else {
              tlog.info(
                { from: recipientAddress, to: senderAddress },
                "Denial reply rate-limited, skipping Mailgun send",
              );
            }
          }
        } else {
          tlog.debug("Mailgun API key not configured — skipping denial reply");
        }
      }

      return Response.json({ ok: true, ...runtimeBody });
    } catch (err) {
      const cbResponse = handleCircuitBreakerError(
        err,
        dedupCache,
        token,
        tlog,
      );
      if (cbResponse) return cbResponse;

      tlog.error({ err, eventId }, "Failed to process inbound Mailgun email");
      dedupCache.unreserve(token);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };

  return { handler, dedupCache };
}
