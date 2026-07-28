import type { Logger } from "pino";
import { buildEmailTransportMetadata } from "../channels/transport-hints.js";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import { resolveCredentialWithRefresh } from "../credential-refresh.js";
import { recordDenialReplyIfAllowed } from "../db/denial-reply-rate-limiter.js";
import type { StringDedupCache } from "../dedup-cache.js";
import { handleInbound } from "../handlers/handle-inbound.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import {
  handleCircuitBreakerError,
  processInboundResult,
} from "../webhook-pipeline.js";
import {
  appendFailedEmailAttachmentNotice,
  ingestEmailAttachments,
} from "./attachments.js";
import type { VellumEmailPayload } from "./normalize.js";
import { normalizeEmailWebhook } from "./normalize.js";

/**
 * Sends a reply email through the provider's API. `kind` selects the log
 * wording ("verification" vs "denial"); `from` is the provider address the
 * inbound email was delivered to, `to` the original sender. Senders log
 * their own outcome — the pipeline proceeds regardless of send success.
 */
export type EmailReplySender = (args: {
  kind: "verification" | "invite" | "denial";
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
 * Resolve a provider credential after the caller has already reserved
 * `dedupKey`. `resolveCredentialWithRefresh` reads through the credential
 * cache, which re-throws on a credential-backend failure; left unguarded that
 * throw would strand the reservation — a {@link StringDedupCache} reservation
 * has no TTL, so the provider's retries would dedup as duplicates and the
 * email would be silently dropped. On a throw, release the reservation and
 * return a 500 so the provider retries and the retry is processed. A missing
 * credential is not an error: it resolves to `undefined` and the caller
 * decides whether that is fatal.
 */
export async function resolveEmailCredentialOrRelease(opts: {
  credentials: CredentialCache | undefined;
  key: string;
  dedupCache: StringDedupCache;
  dedupKey: string;
  log: Logger;
  label: string;
}): Promise<
  { ok: true; value: string | undefined } | { ok: false; response: Response }
> {
  try {
    const value = await resolveCredentialWithRefresh(
      opts.credentials,
      opts.key,
    );
    return { ok: true, value };
  } catch (err) {
    opts.log.error(
      { err },
      `Failed to resolve ${opts.label} credential — releasing dedup reservation for retry`,
    );
    opts.dedupCache.unreserve(opts.dedupKey);
    return {
      ok: false,
      response: Response.json({ error: "Internal error" }, { status: 500 }),
    };
  }
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

  const {
    event: gatewayEvent,
    eventId,
    recipientAddress,
    senderAuthenticated,
    attachments,
  } = normalized;
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
    // Ingest inline base64 attachments into the assistant's attachment store
    // (stored in the conversation workspace) and forward the ids. A transient
    // upload failure throws into the catch below → 500 so the provider retries.
    const ingested = await ingestEmailAttachments(config, attachments, log);
    const attachmentIds =
      ingested.attachmentIds.length > 0 ? ingested.attachmentIds : undefined;
    gatewayEvent.message.content = appendFailedEmailAttachmentNotice(
      gatewayEvent.message.content,
      ingested.failedAttachmentNames,
    );

    const result = await handleInbound(config, gatewayEvent, {
      ...(attachmentIds ? { attachmentIds } : {}),
      transportMetadata: buildEmailTransportMetadata({
        senderAddress,
        recipientAddress,
        subject: vellumPayload.subject,
        inReplyTo: vellumPayload.inReplyTo,
      }),
      replyCallbackUrl: undefined,
      traceId,
      routingOverride: routing,
      // Provider SPF/DKIM/DMARC verdict (from the normalizer). `false` collapses
      // a forged `From:` out of guardian/trusted_contact; `undefined` is a no-op.
      senderAuthenticated,
      sourceMetadata: {
        emailProvider: source,
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

    // Invite redemption replies get the same always-deliver treatment: the
    // gateway consumed the message, so this reply is the sender's only
    // feedback.
    if (result.inviteIntercepted && result.inviteReplyText) {
      if (sendReply) {
        await sendReply({
          kind: "invite",
          from: recipientAddress,
          to: senderAddress,
          subject: replySubject,
          text: result.inviteReplyText,
          inReplyTo: vellumPayload.messageId,
        });
      }
      mark();
      return Response.json({ ok: true, inviteIntercepted: true });
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
