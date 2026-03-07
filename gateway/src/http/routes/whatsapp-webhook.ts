import { timingSafeEqual } from "crypto";
import { buildWhatsAppTransportMetadata } from "../../channels/transport-hints.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import { StringDedupCache } from "../../dedup-cache.js";
import { handleInbound } from "../../handlers/handle-inbound.js";
import { getLogger } from "../../logger.js";
import { RejectionRateLimiter } from "../../rejection-rate-limiter.js";
import {
  resolveAssistant,
  isRejection,
} from "../../routing/resolve-assistant.js";
import {
  AttachmentValidationError,
  uploadAttachment,
} from "../../runtime/client.js";
import {
  handleCircuitBreakerError,
  handleNewCommand,
  isNewCommand,
  processInboundResult,
} from "../../webhook-pipeline.js";
import { ROUTING_REJECTION_NOTICE } from "../../webhook-copy.js";
import { downloadWhatsAppFile } from "../../whatsapp/download.js";
import {
  markWhatsAppMessageRead,
  WhatsAppNonRetryableError,
} from "../../whatsapp/api.js";
import { normalizeWhatsAppWebhook } from "../../whatsapp/normalize.js";
import { sendWhatsAppReply } from "../../whatsapp/send.js";
import { verifyWhatsAppWebhookSignature } from "../../whatsapp/verify.js";

const log = getLogger("whatsapp-webhook");

const rejectionLimiter = new RejectionRateLimiter();

export function createWhatsAppWebhookHandler(
  config: GatewayConfig,
  caches?: { credentials?: CredentialCache },
) {
  // 24-hour TTL — WhatsApp message IDs are globally unique and never reused
  const dedupCache = new StringDedupCache(24 * 60 * 60_000);

  const handler = async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    // Meta sends a GET request to verify the webhook subscription
    if (req.method === "GET") {
      const url = new URL(req.url);
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token && config.whatsappWebhookVerifyToken) {
        const a = Buffer.from(token);
        const b = Buffer.from(config.whatsappWebhookVerifyToken);
        const match = a.length === b.length && timingSafeEqual(a, b);
        if (match) {
          tlog.info("WhatsApp webhook verify token validated");
          // Return the challenge as plain text to complete the handshake
          return new Response(challenge ?? "", { status: 200 });
        }
        tlog.warn("WhatsApp webhook verify token mismatch");
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      return Response.json({ error: "Bad Request" }, { status: 400 });
    }

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Payload size guard
    const contentLength = req.headers.get("content-length");
    if (
      contentLength &&
      Number(contentLength) > config.maxWebhookPayloadBytes
    ) {
      tlog.warn({ contentLength }, "WhatsApp webhook payload too large");
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
        "WhatsApp webhook payload too large",
      );
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }

    // Resolve app secret — prefer cache, fall back to config
    let appSecret: string | undefined;
    if (caches?.credentials) {
      appSecret = await caches.credentials.get(
        "credential:whatsapp:app_secret",
      );
    }
    appSecret ??= config.whatsappAppSecret;

    // Signature validation is required — reject requests when the app secret is not configured
    // rather than silently accepting unauthenticated payloads (fail-closed).
    if (!appSecret) {
      tlog.warn("WhatsApp app secret is not configured — rejecting request");
      return Response.json(
        { error: "Webhook signature validation not configured" },
        { status: 500 },
      );
    }

    let signatureValid = verifyWhatsAppWebhookSignature(
      req.headers,
      rawBody,
      appSecret,
    );

    // One-shot force retry: if verification failed and caches are available,
    // force-refresh the app secret and retry once.
    if (!signatureValid && caches?.credentials) {
      const freshAppSecret = await caches.credentials.get(
        "credential:whatsapp:app_secret",
        { force: true },
      );
      if (freshAppSecret) {
        signatureValid = verifyWhatsAppWebhookSignature(
          req.headers,
          rawBody,
          freshAppSecret,
        );
        if (signatureValid) {
          tlog.info(
            "WhatsApp webhook signature verified after forced credential refresh",
          );
        }
      }
    }

    if (!signatureValid) {
      tlog.warn("WhatsApp webhook signature verification failed");
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const normalizedMessages = normalizeWhatsAppWebhook(payload);
    if (normalizedMessages.length === 0) {
      // Delivery receipts, status updates, etc. — acknowledge silently
      return Response.json({ ok: true });
    }

    // Track whether any message failed so we can signal Meta to retry the batch.
    // Returning 500 causes Meta to resend the webhook; the dedup cache ensures
    // already-processed messages are skipped while failed ones are retried.
    let hasFailure = false;

    for (const normalized of normalizedMessages) {
      const { event, whatsappMessageId, mediaType } = normalized;
      const from = event.message.conversationExternalId;

      // Dedup by WhatsApp message ID — atomically reserve so concurrent retries
      // are blocked while the first request is still processing.
      if (!dedupCache.reserve(whatsappMessageId)) {
        tlog.info(
          { whatsappMessageId },
          "Duplicate WhatsApp message ID, ignoring",
        );
        continue;
      }

      tlog.info(
        {
          source: "whatsapp",
          messageId: whatsappMessageId,
          from,
          ...(mediaType ? { mediaType } : {}),
        },
        "WhatsApp webhook received",
      );

      // Mark message as read (best-effort, do not await)
      markWhatsAppMessageRead(config, whatsappMessageId).catch((err) => {
        tlog.debug(
          { err, messageId: whatsappMessageId },
          "Failed to mark WhatsApp message as read",
        );
      });

      // Resolve routing once so we can gate further operations on it
      const routing = resolveAssistant(config, from, from);

      // Handle /new command — reset conversation before it reaches the runtime
      if (isNewCommand(event.message.content)) {
        if (isRejection(routing)) {
          tlog.warn(
            { from, reason: routing.reason },
            "Routing rejected /new command",
          );
          sendWhatsAppReply(config, from, ROUTING_REJECTION_NOTICE).catch(
            (err) => {
              tlog.error(
                { err, to: from },
                "Failed to send /new routing rejection notice",
              );
            },
          );
        } else {
          await handleNewCommand(
            config,
            event.sourceChannel,
            event.message.conversationExternalId,
            async (text) => {
              await sendWhatsAppReply(config, from, text);
            },
            tlog,
          );
        }

        dedupCache.mark(whatsappMessageId);
        continue;
      }

      if (isRejection(routing)) {
        tlog.warn(
          { from, reason: routing.reason },
          "Routing rejected inbound WhatsApp message",
        );
        if (rejectionLimiter.shouldSend(from)) {
          sendWhatsAppReply(config, from, ROUTING_REJECTION_NOTICE).catch(
            (err) => {
              tlog.error(
                { err, to: from },
                "Failed to send routing rejection notice",
              );
            },
          );
        }
        dedupCache.mark(whatsappMessageId);
        continue;
      }

      // Download and upload attachments if present
      let attachmentIds: string[] | undefined;
      const eventAttachments = event.message.attachments;
      if (eventAttachments && eventAttachments.length > 0) {
        try {
          attachmentIds = [];

          // Filter oversized attachments
          const eligible = eventAttachments.filter((att) => {
            if (
              att.fileSize !== undefined &&
              att.fileSize > config.maxAttachmentBytes
            ) {
              tlog.warn(
                {
                  fileId: att.fileId,
                  fileSize: att.fileSize,
                  limit: config.maxAttachmentBytes,
                },
                "Skipping oversized WhatsApp attachment",
              );
              return false;
            }
            return true;
          });

          // Process with bounded concurrency. Validation errors (unsupported
          // MIME type, dangerous extension) are skipped so that a bad attachment
          // doesn't drop the user's message. Transient errors (download timeout,
          // upload 5xx, network failures) are propagated so that Meta retries
          // the webhook delivery.
          for (
            let i = 0;
            i < eligible.length;
            i += config.maxAttachmentConcurrency
          ) {
            const batch = eligible.slice(
              i,
              i + config.maxAttachmentConcurrency,
            );
            const results = await Promise.allSettled(
              batch.map(async (att) => {
                const downloaded = await downloadWhatsAppFile(
                  config,
                  att.fileId,
                  {
                    fileName: att.fileName,
                    mimeType: att.mimeType,
                  },
                );
                return uploadAttachment(config, downloaded);
              }),
            );
            for (const result of results) {
              if (result.status === "fulfilled") {
                attachmentIds.push(result.value.id);
              } else if (result.reason instanceof AttachmentValidationError) {
                tlog.warn(
                  { err: result.reason },
                  "Skipping WhatsApp attachment with validation error",
                );
              } else if (result.reason instanceof WhatsAppNonRetryableError) {
                tlog.warn(
                  { err: result.reason },
                  "Skipping WhatsApp attachment with non-retryable error",
                );
              } else {
                // Transient failure — propagate so the webhook returns 500 and
                // Meta retries the update delivery.
                throw result.reason;
              }
            }
          }
        } catch (err) {
          // Transient attachment failure — return 500 so Meta retries.
          tlog.error(
            { err },
            "WhatsApp attachment processing failed with transient error",
          );
          dedupCache.unreserve(whatsappMessageId);
          hasFailure = true;
          continue;
        }
      }

      // Media-only messages with no successfully uploaded attachments have
      // nothing to forward — skip silently.
      if (
        event.message.content.length === 0 &&
        (!attachmentIds || attachmentIds.length === 0)
      ) {
        dedupCache.mark(whatsappMessageId);
        continue;
      }

      try {
        const result = await handleInbound(config, event, {
          attachmentIds,
          transportMetadata: buildWhatsAppTransportMetadata(),
          replyCallbackUrl: `${config.gatewayInternalBaseUrl}/deliver/whatsapp`,
          traceId,
          routingOverride: routing,
        });

        const processed = processInboundResult(
          result,
          dedupCache,
          whatsappMessageId,
          () => {
            if (rejectionLimiter.shouldSend(from)) {
              sendWhatsAppReply(config, from, ROUTING_REJECTION_NOTICE).catch(
                (err) => {
                  tlog.error(
                    { err, to: from },
                    "Failed to send routing rejection notice",
                  );
                },
              );
            }
          },
          tlog,
        );

        if (!processed.ok) {
          hasFailure = true;
          continue;
        }

        // Rejected messages are processed successfully (ok: true) but should
        // not be logged as "forwarded" — the rejection callback already handled them.
        if (result.rejected) {
          dedupCache.mark(whatsappMessageId);
          continue;
        }

        dedupCache.mark(whatsappMessageId);
        if (!processed.rejected) {
          tlog.info(
            { status: "forwarded", whatsappMessageId },
            "WhatsApp message forwarded to runtime",
          );
        }
      } catch (err) {
        const cbResponse = handleCircuitBreakerError(
          err,
          dedupCache,
          whatsappMessageId,
          tlog,
        );
        if (cbResponse) return cbResponse;

        tlog.error(
          { err, whatsappMessageId },
          "Failed to process inbound WhatsApp message",
        );
        dedupCache.unreserve(whatsappMessageId);
        hasFailure = true;
      }
    }

    if (hasFailure) {
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    return Response.json({ ok: true });
  };

  return { handler, dedupCache };
}
