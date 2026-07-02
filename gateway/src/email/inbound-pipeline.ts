import type { Logger } from "pino";
import { buildEmailTransportMetadata } from "../channels/transport-hints.js";
import type { GatewayConfig } from "../config.js";
import { recordDenialReplyIfAllowed } from "../db/denial-reply-rate-limiter.js";
import type { StringDedupCache } from "../dedup-cache.js";
import { handleInbound } from "../handlers/handle-inbound.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import {
  handleCircuitBreakerError,
  processInboundResult,
} from "../webhook-pipeline.js";
import type { VellumEmailPayload } from "./normalize.js";
import { normalizeEmailWebhook } from "./normalize.js";

/**
 * Sends a reply email through the provider's API. `kind` selects the log
 * wording ("verification" vs "denial"); `from` is the provider address the
 * inbound email was delivered to, `to` the original sender. Senders log
 * their own outcome — the pipeline proceeds regardless of send success.
 */
export type EmailReplySender = (args: {
  kind: "verification" | "denial";
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
}) => Promise<void>;

export interface EmailInboundPipelineOptions {
  config: GatewayConfig;
  log: Logger;
  /** Capitalized provider name used in log lines, e.g. "Mailgun". */
  label: string;
  /** `source` field for the received log line, e.g. "mailgun". */
  source: string;
  dedupCache: StringDedupCache;
  /** Already-reserved dedup key; an empty string skips mark bookkeeping. */
  dedupKey: string;
  vellumPayload: VellumEmailPayload;
  traceId: string | undefined;
  /** Undefined when the provider has no send credentials — replies are skipped. */
  sendReply: EmailReplySender | undefined;
  /** Extra fields for the received/forwarded log lines (e.g. Resend emailId). */
  logFields?: Record<string, unknown>;
}

/**
 * Shared tail of the provider email webhooks (Mailgun, Resend): canonical
 * email normalization, routing resolution, forwarding to the runtime, and
 * verification/denial replies through the provider-specific `sendReply`.
 * Callers have already verified the webhook signature and reserved
 * `dedupKey` in `dedupCache`.
 */
export async function runEmailInboundPipeline(
  opts: EmailInboundPipelineOptions,
): Promise<Response> {
  const {
    config,
    log,
    label,
    source,
    dedupCache,
    dedupKey,
    vellumPayload,
    traceId,
    sendReply,
    logFields,
  } = opts;

  const mark = () => {
    if (dedupKey) {
      dedupCache.mark(dedupKey);
    }
  };

  const normalized = normalizeEmailWebhook(
    vellumPayload as unknown as Record<string, unknown>,
  );
  if (!normalized) {
    log.debug(
      `normalizeEmailWebhook returned null for ${label} event, acknowledging`,
    );
    mark();
    return Response.json({ ok: true });
  }

  const { event: gatewayEvent, eventId, recipientAddress } = normalized;
  const senderAddress = gatewayEvent.actor.actorExternalId;

  log.info(
    {
      source,
      eventId,
      ...logFields,
      from: senderAddress,
      to: recipientAddress,
    },
    `${label} webhook received`,
  );

  const routing = resolveAssistant(
    config,
    gatewayEvent.message.conversationExternalId,
    senderAddress,
  );

  if (isRejection(routing)) {
    log.warn(
      {
        from: senderAddress,
        to: recipientAddress,
        reason: routing.reason,
      },
      `Routing rejected inbound ${label} email`,
    );
    mark();
    return Response.json({ ok: true });
  }

  const replySubject = `Re: ${vellumPayload.subject ?? "(no subject)"}`;

  try {
    const result = await handleInbound(config, gatewayEvent, {
      transportMetadata: buildEmailTransportMetadata({
        senderAddress,
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

    // Verification success confirmations are always delivered — never
    // gated by the denial-reply rate limiter.
    if (result.verificationIntercepted && result.verificationReplyText) {
      if (sendReply) {
        await sendReply({
          kind: "verification",
          from: recipientAddress,
          to: senderAddress,
          subject: replySubject,
          text: result.verificationReplyText,
          inReplyTo: vellumPayload.messageId,
        });
      }
      mark();
      return Response.json({ ok: true, verificationIntercepted: true });
    }

    const processed = processInboundResult(
      result,
      dedupCache,
      dedupKey,
      () => {
        log.warn(
          { from: senderAddress, to: recipientAddress },
          `${label} email routing rejected after forwarding attempt`,
        );
      },
      log,
    );

    if (!processed.ok) {
      return Response.json({ error: "Internal error" }, { status: 500 });
    }

    mark();

    if (!result.rejected) {
      log.info(
        { status: "forwarded", eventId, ...logFields },
        `${label} email message forwarded to runtime`,
      );
    }

    // When the runtime denies the message (ACL rejection) and provides
    // replyText, send a reply email so the unknown sender knows why their
    // message was rejected. The runtime can't send email directly (no
    // replyCallbackUrl for email), so the gateway handles it.
    const runtimeBody = result.runtimeResponse ?? {};
    if (
      result.runtimeResponse?.denied &&
      result.runtimeResponse.replyText &&
      sendReply
    ) {
      if (recordDenialReplyIfAllowed("email", senderAddress)) {
        await sendReply({
          kind: "denial",
          from: recipientAddress,
          to: senderAddress,
          subject: replySubject,
          text: result.runtimeResponse.replyText,
          inReplyTo: vellumPayload.messageId,
        });
      } else {
        log.info(
          { from: recipientAddress, to: senderAddress },
          `Denial reply rate-limited, skipping ${label} send`,
        );
      }
    }

    return Response.json({ ok: true, ...runtimeBody });
  } catch (err) {
    const cbResponse = handleCircuitBreakerError(
      err,
      dedupCache,
      dedupKey,
      log,
    );
    if (cbResponse) {
      return cbResponse;
    }

    log.error({ err, eventId }, `Failed to process inbound ${label} email`);
    dedupCache.unreserve(dedupKey);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
