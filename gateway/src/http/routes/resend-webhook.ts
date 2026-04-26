import { createHmac, timingSafeEqual } from "node:crypto";
import { buildEmailTransportMetadata } from "../../channels/transport-hints.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { StringDedupCache } from "../../dedup-cache.js";
import type { VellumEmailPayload } from "../../email/normalize.js";
import { normalizeEmailWebhook } from "../../email/normalize.js";
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

const log = getLogger("resend-webhook");

/**
 * Maximum age (in seconds) for the svix-timestamp header before we reject
 * the webhook as too old. Matches Svix's default tolerance of 5 minutes.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// ── Svix signature verification ─────────────────────────────────────

/**
 * Verify a Resend/Svix webhook signature.
 *
 * Svix signs webhooks with HMAC-SHA256 using the base64-decoded portion
 * of the webhook secret (everything after the `whsec_` prefix).
 *
 * The signed content is: `${svix-id}.${svix-timestamp}.${rawBody}`
 *
 * The `svix-signature` header contains one or more space-delimited
 * versioned signatures (e.g. `v1,<base64>`). We verify against all `v1`
 * entries and succeed if any match.
 */
function verifySvixSignature(
  headers: Headers,
  rawBody: string,
  secret: string,
): boolean {
  const msgId = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatureHeader = headers.get("svix-signature");

  if (!msgId || !timestamp || !signatureHeader) return false;

  // Reject stale timestamps to prevent replay attacks
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  // Extract the raw key bytes — secret may have a `whsec_` prefix
  const secretPart = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretPart, "base64");

  // Compute expected signature
  const signedContent = `${msgId}.${timestamp}.${rawBody}`;
  const expectedSig = createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest("base64");

  // svix-signature may contain multiple space-delimited entries like
  // "v1,<base64> v1,<base64> v2,<base64>"
  const signatures = signatureHeader.split(" ");
  for (const entry of signatures) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;

    const expectedBuf = Buffer.from(expectedSig);
    const providedBuf = Buffer.from(sig);
    if (expectedBuf.length !== providedBuf.length) continue;

    if (timingSafeEqual(expectedBuf, providedBuf)) return true;
  }

  return false;
}

// ── Resend inbound payload normalization ────────────────────────────

/**
 * Shape of the Resend `email.received` webhook event.
 *
 * The webhook payload contains metadata only — the email body must be
 * fetched separately via `GET /emails/receiving/{email_id}`.
 */
interface ResendReceivedEvent {
  type: "email.received";
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    message_id: string;
    attachments?: Array<{
      id: string;
      filename: string;
      content_type: string;
    }>;
  };
}

/**
 * Fetch the full email content from the Resend Receiving API.
 *
 * Returns the email body (html/text), headers, and metadata.
 */
async function fetchResendEmailContent(
  emailId: string,
  apiKey: string,
): Promise<{
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
} | null> {
  try {
    const response = await fetch(
      `https://api.resend.com/emails/receiving/${emailId}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    );
    if (!response.ok) {
      log.error(
        { emailId, status: response.status },
        "Failed to fetch Resend email content",
      );
      return null;
    }
    const data = (await response.json()) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    if (data.headers && typeof data.headers === "object") {
      for (const [k, v] of Object.entries(
        data.headers as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
    }
    return {
      html: (data.html as string) ?? null,
      text: (data.text as string) ?? null,
      headers,
    };
  } catch (err) {
    log.error({ err, emailId }, "Error fetching Resend email content");
    return null;
  }
}

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
 * Normalize a Resend `email.received` webhook event into a
 * `VellumEmailPayload` suitable for `normalizeEmailWebhook()`.
 */
function normalizeResendToVellumPayload(
  event: ResendReceivedEvent,
  content: {
    html: string | null;
    text: string | null;
    headers: Record<string, string>;
  } | null,
): VellumEmailPayload | null {
  const { data } = event;
  if (!data.from || !data.to?.length || !data.message_id) return null;

  // Extract threading headers from the full email content if available
  const inReplyTo = content?.headers["in-reply-to"] ?? undefined;
  const references = content?.headers["references"] ?? undefined;

  // Use the first 'to' address as the recipient for routing
  const recipientAddress = data.to[0];

  // Derive a stable conversation ID using the root of the References
  // chain (first entry = thread root Message-ID per RFC 5322). This
  // ensures all replies in a thread resolve to the same conversation.
  // Falls back to recipientAddress for new threads with no References.
  const referencesRoot = references?.trim().split(/\s+/)[0];
  const conversationId = referencesRoot ?? recipientAddress;

  // Prefer plain text; fall back to raw HTML so HTML-only emails aren't empty
  const bodyText = content?.text ?? content?.html ?? undefined;
  const strippedText = content?.text ?? undefined;

  // Parse from into canonical address + optional display name
  const parsed = parseEmailAddress(data.from);

  return {
    from: parsed.address,
    fromName: parsed.displayName,
    to: recipientAddress,
    subject: data.subject,
    strippedText,
    bodyText,
    messageId: data.message_id,
    inReplyTo,
    references,
    conversationId,
    timestamp: data.created_at,
  };
}

// ── Webhook handler factory ─────────────────────────────────────────

export function createResendWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
) {
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
      tlog.warn({ contentLength }, "Resend webhook payload too large");
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return Response.json({ error: "Failed to read body" }, { status: 400 });
    }

    if (Buffer.byteLength(rawBody) > config.maxWebhookPayloadBytes) {
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    // ── Credential resolution ───────────────────────────────────────
    // We need two credentials:
    //   resend/webhook_secret — for Svix signature verification
    //   resend/api_key        — for fetching email content from the API

    const resolveCredential = async (
      key: string,
    ): Promise<string | undefined> => {
      if (!caches?.credentials) return undefined;
      let value = await caches.credentials.get(key);
      if (!value) {
        value = await caches.credentials.get(key, { force: true });
      }
      return value;
    };

    const webhookSecret = await resolveCredential(
      credentialKey("resend", "webhook_secret"),
    );

    if (!webhookSecret) {
      tlog.warn("Resend webhook secret not configured — rejecting request");
      return Response.json(
        { error: "Webhook secret not configured" },
        { status: 409 },
      );
    }

    // ── Signature verification ──────────────────────────────────────

    let signatureValid = verifySvixSignature(
      req.headers,
      rawBody,
      webhookSecret,
    );

    // One-shot force retry on verification failure
    if (!signatureValid && caches?.credentials) {
      const freshSecret = await caches.credentials.get(
        credentialKey("resend", "webhook_secret"),
        { force: true },
      );
      if (freshSecret) {
        signatureValid = verifySvixSignature(req.headers, rawBody, freshSecret);
        if (signatureValid) {
          tlog.info(
            "Resend webhook signature verified after forced credential refresh",
          );
        }
      }
    }

    if (!signatureValid) {
      tlog.warn("Resend webhook signature verification failed");
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Parse event ─────────────────────────────────────────────────

    let event: ResendReceivedEvent;
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (parsed.type !== "email.received") {
        // Acknowledge non-email events silently (delivery status, bounces, etc.)
        tlog.debug({ type: parsed.type }, "Ignoring non-received Resend event");
        return Response.json({ ok: true });
      }
      event = parsed as unknown as ResendReceivedEvent;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const emailId = event.data?.email_id;
    const messageId = event.data?.message_id;

    if (!emailId || !messageId) {
      tlog.debug("Resend event missing email_id or message_id, acknowledging");
      return Response.json({ ok: true });
    }

    // Dedup by message ID
    if (!dedupCache.reserve(messageId)) {
      tlog.info({ messageId }, "Duplicate Resend event, ignoring");
      return Response.json({ ok: true });
    }

    // ── Fetch email content ─────────────────────────────────────────
    // The webhook payload only has metadata — we need the API to get
    // the actual email body and headers.

    const apiKey = await resolveCredential(credentialKey("resend", "api_key"));

    let emailContent: Awaited<ReturnType<typeof fetchResendEmailContent>> =
      null;
    if (apiKey) {
      emailContent = await fetchResendEmailContent(emailId, apiKey);
    } else {
      tlog.warn(
        "Resend API key not configured — email body will be unavailable",
      );
    }

    // ── Normalize to VellumEmailPayload ─────────────────────────────

    const vellumPayload = normalizeResendToVellumPayload(event, emailContent);
    if (!vellumPayload) {
      tlog.debug("Resend event missing required fields, acknowledging");
      dedupCache.mark(messageId);
      return Response.json({ ok: true });
    }

    // Feed into the standard email normalization pipeline
    const normalized = normalizeEmailWebhook(
      vellumPayload as unknown as Record<string, unknown>,
    );
    if (!normalized) {
      tlog.debug(
        "normalizeEmailWebhook returned null for Resend event, acknowledging",
      );
      dedupCache.mark(messageId);
      return Response.json({ ok: true });
    }

    const { event: gatewayEvent, eventId, recipientAddress } = normalized;

    tlog.info(
      {
        source: "resend",
        eventId,
        emailId,
        from: gatewayEvent.actor.actorExternalId,
        to: recipientAddress,
      },
      "Resend webhook received",
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
        "Routing rejected inbound Resend email",
      );
      dedupCache.mark(messageId);
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
        messageId,
        () => {
          tlog.warn(
            { from: gatewayEvent.actor.actorExternalId, to: recipientAddress },
            "Resend email routing rejected after forwarding attempt",
          );
        },
        tlog,
      );

      if (!processed.ok) {
        return Response.json({ error: "Internal error" }, { status: 500 });
      }

      dedupCache.mark(messageId);

      if (!result.rejected) {
        tlog.info(
          { status: "forwarded", eventId, emailId },
          "Resend email message forwarded to runtime",
        );
      }

      // ── Denial reply ────────────────────────────────────────────
      // When the runtime denies the message (ACL rejection) and provides
      // replyText, send a reply email so the unknown sender knows why
      // their message was rejected. The runtime can't send email directly
      // (no replyCallbackUrl for email), so the gateway handles it.
      const runtimeBody = result.runtimeResponse ?? {};
      if (
        result.runtimeResponse?.denied &&
        result.runtimeResponse.replyText &&
        apiKey
      ) {
        const senderAddress = gatewayEvent.actor.actorExternalId;
        try {
          const sendResponse = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: recipientAddress,
              to: [senderAddress],
              subject: `Re: ${vellumPayload.subject ?? "(no subject)"}`,
              text: result.runtimeResponse.replyText,
              ...(vellumPayload.messageId
                ? {
                    headers: {
                      "In-Reply-To": vellumPayload.messageId,
                    },
                  }
                : {}),
            }),
          });
          if (sendResponse.ok) {
            tlog.info(
              { from: recipientAddress, to: senderAddress },
              "Sent denial reply via Resend",
            );
          } else {
            tlog.warn(
              {
                status: sendResponse.status,
                from: recipientAddress,
                to: senderAddress,
              },
              "Failed to send denial reply via Resend",
            );
          }
        } catch (err) {
          tlog.error(
            { err, from: recipientAddress, to: senderAddress },
            "Error sending denial reply via Resend",
          );
        }
      }

      return Response.json({ ok: true, ...runtimeBody });
    } catch (err) {
      const cbResponse = handleCircuitBreakerError(
        err,
        dedupCache,
        messageId,
        tlog,
      );
      if (cbResponse) return cbResponse;

      tlog.error({ err, eventId }, "Failed to process inbound Resend email");
      dedupCache.unreserve(messageId);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };

  return { handler, dedupCache };
}
