import {
  makeResolutionFailedVerdict,
  makeUnauthenticatedSenderVerdict,
  type SourceMetadata,
  type TrustVerdict,
} from "@vellumai/gateway-client";
import type { GatewayConfig } from "../config.js";
import { ContactStore } from "../db/contact-store.js";
import { getLogger } from "../logger.js";
import { resolveAdmissionPolicy } from "../risk/admission-policy-cache.js";
import { resolveTrustVerdict } from "../risk/trust-verdict-resolver.js";
import {
  canonicalizeInboundIdentity,
  canonicalSenderIdFor,
} from "../verification/identity.js";
import { resolveAssistant, isRejection } from "../routing/resolve-assistant.js";
import type { RouteResult } from "../routing/types.js";
import {
  forwardToRuntime,
  CircuitBreakerOpenError,
} from "../runtime/client.js";
import type { RuntimeInboundResponse } from "../runtime/client.js";
import type { GatewayInboundEvent } from "../types.js";
import { tryInviteRedemptionIntercept } from "../verification/invite-redemption.js";
import { tryTextVerificationIntercept } from "../verification/text-verification.js";

const log = getLogger("handle-inbound");

export type InboundResult = {
  forwarded: boolean;
  rejected: boolean;
  verificationIntercepted?: boolean;
  /** Reply text when the verification intercept couldn't deliver (no replyCallbackUrl). */
  verificationReplyText?: string;
  inviteIntercepted?: boolean;
  /** Reply text when the invite intercept couldn't deliver (no replyCallbackUrl). */
  inviteReplyText?: string;
  runtimeResponse?: RuntimeInboundResponse;
  rejectionReason?: string;
};

export type TransportMetadataOverrides = {
  hints?: string[];
  uxBrief?: string;
};

export type HandleInboundOptions = {
  attachmentIds?: string[];
  transportMetadata?: TransportMetadataOverrides;
  replyCallbackUrl?: string;
  traceId?: string;
  /** When provided, skip resolveAssistant() and use this pre-resolved route. */
  routingOverride?: RouteResult;
  /** Extra fields merged into sourceMetadata (e.g. commandIntent). */
  sourceMetadata?: Partial<SourceMetadata>;
  /**
   * Result of the ingress channel's sender-authentication check (email
   * SPF/DKIM/DMARC). `false` means the sender's identity (e.g. the `From:`
   * address) could not be authenticated and is spoofable — the resolved
   * verdict is downgraded to a plain stranger so it cannot inherit
   * guardian/trusted_contact trust from a matching address. `undefined` means
   * the channel does not authenticate senders, or the provider carried no
   * result, and preserves the resolved verdict.
   */
  senderAuthenticated?: boolean;
};

function normalizeTransportHints(hints: string[] | undefined): string[] {
  if (!hints || hints.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of hints) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export async function handleInbound(
  config: GatewayConfig,
  event: GatewayInboundEvent,
  options?: HandleInboundOptions,
): Promise<InboundResult> {
  // ── Admission policy: `no_one` kill switch ──
  // Channel-global hard-deny, evaluated BEFORE routing so a channel set to
  // `no_one` denies every inbound with the kill-switch reason — even an
  // unmapped chat that would otherwise exit via the routing-rejection path
  // and read as a setup failure. Also runs before `tryTextVerificationIntercept`
  // because the kill switch admits nobody — verification-code redemption during
  // a `no_one` lockout would upgrade an actor on a channel the guardian has
  // explicitly turned off.
  //
  // Defense in depth: the §8.1 exempt set (vellum/platform/a2a) skips this
  // check so a guardian can never lock themselves out of the desktop client
  // via the admission UI. The same exemption is enforced PUT-side in
  // channel-admission-policy.ts and at the runtime admission stage.
  const admissionPolicy = resolveAdmissionPolicy(event.sourceChannel);
  if (admissionPolicy === "no_one") {
    log.info(
      {
        sourceChannel: event.sourceChannel,
        conversationExternalId: event.message.conversationExternalId,
        actorExternalId: event.actor.actorExternalId,
      },
      "Inbound event hard-denied by admission policy 'no_one'",
    );
    return {
      forwarded: false,
      rejected: true,
      rejectionReason: "admission_no_one",
    };
  }

  const routing =
    options?.routingOverride ??
    resolveAssistant(
      config,
      event.message.conversationExternalId,
      event.actor.actorExternalId,
    );

  if (isRejection(routing)) {
    log.info(
      {
        conversationExternalId: event.message.conversationExternalId,
        reason: routing.reason,
      },
      "Inbound event rejected by routing",
    );
    return {
      forwarded: false,
      rejected: true,
      rejectionReason: routing.reason,
    };
  }

  const displayName = event.actor.displayName || event.actor.username;

  // ── Text verification intercept ──
  // Must run before forwardToRuntime so the assistant never sees
  // verification code messages. Both success and failure short-circuit.
  const verificationResult = await tryTextVerificationIntercept({
    sourceChannel: event.sourceChannel,
    messageContent: event.message.content,
    actorExternalUserId: event.actor.actorExternalId,
    actorChatId: event.message.conversationExternalId,
    actorDisplayName: event.actor.displayName,
    actorUsername: event.actor.username,
    replyCallbackUrl: options?.replyCallbackUrl,
    assistantId: routing.assistantId,
  });

  if (verificationResult.intercepted) {
    log.info(
      {
        sourceChannel: event.sourceChannel,
        outcome: verificationResult.outcome,
        trustClass: verificationResult.trustClass,
      },
      "Text verification intercepted — not forwarding to runtime",
    );
    return {
      forwarded: false,
      rejected: false,
      verificationIntercepted: true,
      verificationReplyText: verificationResult.pendingReplyText,
    };
  }

  // ── Per-actor trust verdict ──
  // Resolved from the gateway ACL DB and stamped on sourceMetadata for the
  // runtime to consume. Runs after the verification intercept (messages it
  // consumes never pay resolution cost) and before the invite intercept,
  // which gates on the resolved class.
  let trustVerdict: TrustVerdict | undefined;
  try {
    trustVerdict = await resolveTrustVerdict({
      channelType: event.sourceChannel,
      actorExternalId: event.actor.actorExternalId,
    });
  } catch (err) {
    // Producer fails soft — resolution never breaks ingress. Stamp a sentinel
    // so the consumer can tell a resolver failure from a real stranger.
    log.warn({ err }, "trust verdict resolution failed; stamping sentinel");
    trustVerdict = makeResolutionFailedVerdict(
      canonicalSenderIdFor(event.sourceChannel, event.actor.actorExternalId),
    );
  }

  // ── Sender-authentication downgrade ──
  // Trust is keyed on the actor's channel address, which some channels (email)
  // carry from a spoofable `From:` header. When the ingress reports the sender
  // failed channel authentication (SPF/DKIM/DMARC), never let a forged address
  // that happens to match a guardian/contact record inherit that trust —
  // collapse the verdict to a plain stranger so the admission floor and
  // verification lane treat it as unknown. `undefined` means "not evaluated"
  // (non-authenticating channel, or a payload with no result) and is a no-op.
  if (options?.senderAuthenticated === false && trustVerdict) {
    const priorClass = trustVerdict.trustClass;
    trustVerdict = makeUnauthenticatedSenderVerdict(
      trustVerdict.canonicalSenderId,
    );
    if (priorClass !== "unknown") {
      log.warn(
        {
          sourceChannel: event.sourceChannel,
          actorExternalId: event.actor.actorExternalId,
          resolvedTrustClass: priorClass,
        },
        "Inbound sender failed channel authentication — downgrading trust to stranger",
      );
    }
  }

  // ── Invite redemption intercept ──
  // Bare 6-digit invite codes and `/start iv_<token>` deep links from
  // non-member senders are redeemed at the gateway; the runtime never sees
  // them. A code that matches no invite falls through as a normal message.
  // Unauthenticated senders never redeem: a spoofable address must not mint
  // a membership binding it may not own.
  if (options?.senderAuthenticated !== false) {
    const inviteResult = await tryInviteRedemptionIntercept({
      sourceChannel: event.sourceChannel,
      messageContent: event.message.content,
      commandIntent: options?.sourceMetadata?.commandIntent,
      actorExternalUserId: event.actor.actorExternalId,
      actorChatId: event.message.conversationExternalId,
      actorDisplayName: event.actor.displayName,
      actorUsername: event.actor.username,
      replyCallbackUrl: options?.replyCallbackUrl,
      assistantId: routing.assistantId,
      trustVerdict,
    });

    if (inviteResult.intercepted) {
      log.info(
        {
          sourceChannel: event.sourceChannel,
          outcome: inviteResult.outcome,
        },
        "Invite redemption intercepted — not forwarding to runtime",
      );
      return {
        forwarded: false,
        rejected: false,
        inviteIntercepted: true,
        inviteReplyText: inviteResult.pendingReplyText,
      };
    }
  }

  const transportHints = normalizeTransportHints(
    options?.transportMetadata?.hints,
  );
  const transportUxBrief = options?.transportMetadata?.uxBrief?.trim();
  const sourceChannelName = event.source.channelName?.trim();

  try {
    const response = await forwardToRuntime(
      config,
      {
        sourceChannel: event.sourceChannel,
        interface: event.sourceChannel,
        conversationExternalId: event.message.conversationExternalId,
        externalMessageId: event.message.externalMessageId,
        content: event.message.content,
        ...(event.message.isEdit ? { isEdit: true } : {}),
        ...(event.message.callbackQueryId
          ? { callbackQueryId: event.message.callbackQueryId }
          : {}),
        ...(event.message.callbackData
          ? { callbackData: event.message.callbackData }
          : {}),
        actorDisplayName: displayName,
        actorExternalId: event.actor.actorExternalId,
        actorUsername: event.actor.username,
        sourceMetadata: {
          updateId: event.source.updateId,
          messageId: event.source.messageId,
          chatType: event.source.chatType,
          ...(event.source.threadId ? { threadId: event.source.threadId } : {}),
          ...(sourceChannelName ? { channelName: sourceChannelName } : {}),
          languageCode: event.actor.languageCode,
          isBot: event.actor.isBot,
          timezone: event.actor.timezone,
          timezoneLabel: event.actor.timezoneLabel,
          timezoneOffsetSeconds: event.actor.timezoneOffsetSeconds,
          isStranger: event.actor.isStranger,
          isRestricted: event.actor.isRestricted,
          ...(event.actor.teamId ? { actorTeamId: event.actor.teamId } : {}),
          ...(transportHints.length > 0 ? { hints: transportHints } : {}),
          ...(transportUxBrief ? { uxBrief: transportUxBrief } : {}),
          // Floor for the runtime admission stage. Exempt channels send no
          // value; the runtime's own exempt-channel short-circuit then
          // admits unconditionally. Non-exempt channels always carry the
          // cache value (default `trusted_contacts` when the row is absent).
          ...(admissionPolicy ? { admissionPolicy } : {}),
          ...(trustVerdict ? { trustVerdict } : {}),
          ...(options?.sourceMetadata ?? {}),
        },
        ...(options?.attachmentIds?.length
          ? { attachmentIds: options.attachmentIds }
          : {}),
        ...(options?.replyCallbackUrl
          ? { replyCallbackUrl: options.replyCallbackUrl }
          : {}),
      },
      { traceId: options?.traceId },
    );

    log.info(
      {
        assistantId: routing.assistantId,
        routeSource: routing.routeSource,
        eventId: response.eventId,
        duplicate: response.duplicate,
        hasReply: !!response.assistantMessage,
        denied: response.denied ?? false,
        deniedReason: response.denied
          ? (response.reason ?? "unknown")
          : undefined,
      },
      response.denied
        ? "Inbound event denied by runtime"
        : "Inbound event forwarded to runtime",
    );

    // ── Contact channel interaction tracking ──
    // Fire-and-forget so write failures here cannot leak as unhandled
    // rejections.
    if (!response.denied) {
      void touchContactChannelStats(event, response.duplicate).catch(() => {});
    }

    return { forwarded: true, rejected: false, runtimeResponse: response };
  } catch (err) {
    // Let CircuitBreakerOpenError propagate so webhook handlers can
    // return 503 + Retry-After instead of 500, which would cause
    // Telegram (and similar transports) to retry immediately.
    if (err instanceof CircuitBreakerOpenError) throw err;

    log.error(
      { err, assistantId: routing.assistantId },
      "Failed to forward inbound event to runtime",
    );
    return { forwarded: false, rejected: false };
  }
}

// ---------------------------------------------------------------------------
// Contact channel interaction tracking
// ---------------------------------------------------------------------------

/**
 * Resolve the contact channel from the gateway store and write interaction
 * stats to the gateway DB.
 *
 * Caller wraps in `.catch(() => {})` so failures cannot surface as unhandled
 * rejections.
 */
async function touchContactChannelStats(
  event: GatewayInboundEvent,
  duplicate: boolean,
): Promise<void> {
  const canonicalActorId =
    canonicalizeInboundIdentity(
      event.sourceChannel,
      event.actor.actorExternalId,
    ) ?? event.actor.actorExternalId;

  const store = new ContactStore();
  const channelId = store.findChannelIdByAddress(
    event.sourceChannel,
    canonicalActorId,
    event.message.conversationExternalId,
  );
  if (!channelId) return;

  store.touchChannelLastSeen(channelId);
  if (!duplicate) {
    store.touchContactInteraction(channelId);
  }
}
