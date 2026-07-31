/**
 * Residual synchronous actor-trust view.
 *
 * The canonical classifier is the gateway's trust-verdict resolver
 * (`gateway/src/risk/trust-verdict-resolver.ts`); inbound paths consume its
 * stamped verdict via `trust-verdict-consumer.ts`. This module survives for
 * two narrow jobs:
 *
 * - {@link resolveActorTrust}: a sync, IO-free guardian-or-unknown
 *   classification read from the guardian-delivery cache snapshot. Its sole
 *   production caller is the vellum reset-drift re-resolution
 *   (`reResolveTrustOnResetDrift` via `resolveTrustContext`), which runs
 *   exactly when the gateway verdict came back `unknown` and so cannot
 *   consume a verdict. Member (contact) classification is verdict-only and
 *   never happens here.
 * - {@link toTrustContext}: the single canonical {@link ActorTrustContext} →
 *   {@link TrustContext} conversion, shared with the verdict consumer.
 */

import type { ChannelId } from "../channels/types.js";
import {
  guardianForChannel,
  peekCachedGuardianDelivery,
} from "../contacts/guardian-delivery-reader.js";
import { channelStatusToMemberStatus } from "../contacts/member-status.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactChannel,
  ContactRole,
  ContactWithChannels,
} from "../contacts/types.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { canonicalizeInboundIdentity } from "../util/canonicalize-identity.js";
import { getLogger } from "../util/logger.js";
import type { TrustClass } from "./trust-class.js";

const log = getLogger("actor-trust-resolver");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trust classification for an inbound actor. Defined once in `./trust-class.ts`
 * (shared with the persistence metadata schema) and re-exported here, the
 * canonical import site for the resolver's consumers.
 */
export type { TrustClass };

/**
 * Fully resolved trust context from the actor trust resolver.
 *
 * This is the intermediate representation between raw inbound identity
 * fields ({@link ResolveActorTrustInput}) and the runtime trust context
 * ({@link TrustContext}). It carries the full resolution state including
 * canonical identity, guardian binding match, member record, and trust
 * classification. Convert to `TrustContext` via {@link toTrustContext}
 * for use in sessions and tooling.
 */
export interface ActorTrustContext {
  /** Canonical (normalized) sender identity. Null when identity could not be established. */
  canonicalSenderId: string | null;
  /** Guardian binding match, if any, for this (assistantId, channel). */
  guardianBindingMatch: {
    guardianExternalUserId: string;
    guardianDeliveryChatId: string | null;
  } | null;
  /** Canonical principal ID from the guardian binding. */
  guardianPrincipalId?: string;
  /**
   * Resolved contact + channel for this sender, if any. The ACL view
   * (status/policy/role) is carried here rather than on the contact/channel
   * objects, sourced from the gateway verdict. Populated only by the verdict
   * consumer (`actorTrustContextFromVerdict`); always null from
   * {@link resolveActorTrust}.
   */
  memberRecord: {
    contact: ContactWithChannels;
    channel: ContactChannel;
    status: ChannelStatus;
    policy: ChannelPolicy;
    role: ContactRole;
  } | null;
  /** Trust classification. */
  trustClass: TrustClass;
  /** Assistant-facing metadata for downstream consumption. */
  actorMetadata: {
    identifier: string | undefined;
    displayName: string | undefined;
    senderDisplayName: string | undefined;
    memberDisplayName: string | undefined;
    username: string | undefined;
    channel: ChannelId;
    trustStatus: TrustClass;
  };
}

/**
 * Raw identity fields from an inbound channel message, used as input to
 * {@link resolveActorTrust}. These are the channel-agnostic identity
 * signals available at message ingress before any trust resolution.
 */
export interface ResolveActorTrustInput {
  assistantId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  actorExternalId?: string;
  actorUsername?: string;
  actorDisplayName?: string;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the inbound actor's trust context from raw identity fields,
 * without IO.
 *
 * 1. Canonicalize the sender identity (E.164 for phone channels, trimmed ID otherwise).
 * 2. Read the guardian binding for the channel from the cached delivery snapshot.
 * 3. Classify: guardian on an address match, otherwise unknown. Member
 *    classification (trusted_contact / unverified_contact) is verdict-only.
 */
export function resolveActorTrust(
  input: ResolveActorTrustInput,
): ActorTrustContext {
  const rawUserId =
    typeof input.actorExternalId === "string" &&
    input.actorExternalId.trim().length > 0
      ? input.actorExternalId.trim()
      : undefined;

  const senderUsername =
    typeof input.actorUsername === "string" &&
    input.actorUsername.trim().length > 0
      ? input.actorUsername.trim()
      : undefined;

  const senderDisplayName =
    typeof input.actorDisplayName === "string" &&
    input.actorDisplayName.trim().length > 0
      ? input.actorDisplayName.trim()
      : undefined;

  // Canonical identity: normalize phone-like channels to E.164.
  const canonicalSenderId = rawUserId
    ? canonicalizeInboundIdentity(input.sourceChannel, rawUserId)
    : null;

  const identifier = senderUsername
    ? `@${senderUsername}`
    : (canonicalSenderId ?? undefined);

  // No identity at all => unknown
  if (!canonicalSenderId) {
    return {
      canonicalSenderId: null,
      guardianBindingMatch: null,
      guardianPrincipalId: undefined,
      memberRecord: null,
      trustClass: "unknown",
      actorMetadata: {
        identifier,
        displayName: senderDisplayName,
        senderDisplayName,
        memberDisplayName: undefined,
        username: senderUsername,
        channel: input.sourceChannel,
        trustStatus: "unknown",
      },
    };
  }

  // --- Guardian lookup ---
  // Sync read of the gateway guardian delivery from the IO-free cache snapshot
  // (kept warm by the async hot paths + daemon-startup warm). A cold cache
  // yields no guardian match, the same outcome as no binding.
  const cachedGuardians = peekCachedGuardianDelivery({
    channelTypes: [input.sourceChannel],
  });
  const guardianDelivery = cachedGuardians
    ? guardianForChannel(cachedGuardians, input.sourceChannel)
    : undefined;
  let guardianBindingMatch: ActorTrustContext["guardianBindingMatch"] = null;
  let guardianPrincipalId: string | undefined;
  let isGuardian = false;

  if (guardianDelivery) {
    guardianBindingMatch = {
      guardianExternalUserId: guardianDelivery.address,
      guardianDeliveryChatId: guardianDelivery.externalChatId ?? null,
    };
    guardianPrincipalId = guardianDelivery.principalId ?? undefined;
    isGuardian =
      guardianDelivery.address.toLowerCase() ===
      canonicalSenderId.toLowerCase();
  }

  log.debug(
    {
      channel: input.sourceChannel,
      source: "guardian-delivery-cache",
      found: !!guardianBindingMatch,
    },
    "trust-resolver guardian lookup",
  );

  // Member classification is verdict-only (`actorTrustContextFromVerdict`):
  // guardian-or-unknown is the only distinction this sync view can make.
  const trustClass: TrustClass = isGuardian ? "guardian" : "unknown";

  return {
    canonicalSenderId,
    guardianBindingMatch,
    guardianPrincipalId,
    memberRecord: null,
    trustClass,
    actorMetadata: {
      identifier,
      displayName: senderDisplayName,
      senderDisplayName,
      memberDisplayName: undefined,
      username: senderUsername,
      channel: input.sourceChannel,
      trustStatus: trustClass,
    },
  };
}

/**
 * Convert an ActorTrustContext into the runtime TrustContext shape used by
 * sessions/tooling.
 *
 * This is the single canonical conversion from resolved trust to runtime
 * context. The guardianExternalUserId is canonicalized to handle phone-
 * channel formatting variance (e.g. stored binding vs E.164).
 */
export function toTrustContext(
  ctx: ActorTrustContext,
  conversationExternalId: string,
): TrustContext {
  const normalizedGuardianExternalUserId = ctx.guardianBindingMatch
    ?.guardianExternalUserId
    ? (canonicalizeInboundIdentity(
        ctx.actorMetadata.channel,
        ctx.guardianBindingMatch.guardianExternalUserId,
      ) ?? undefined)
    : undefined;
  return {
    sourceChannel: ctx.actorMetadata.channel,
    trustClass: ctx.trustClass,
    guardianChatId:
      ctx.guardianBindingMatch?.guardianDeliveryChatId ??
      (ctx.trustClass === "guardian" ? conversationExternalId : undefined),
    guardianExternalUserId: normalizedGuardianExternalUserId,
    guardianPrincipalId: ctx.guardianPrincipalId,
    requesterIdentifier: ctx.actorMetadata.identifier,
    requesterDisplayName: ctx.actorMetadata.displayName,
    requesterSenderDisplayName: ctx.actorMetadata.senderDisplayName,
    requesterMemberDisplayName: ctx.actorMetadata.memberDisplayName,
    requesterExternalUserId: ctx.canonicalSenderId ?? undefined,
    requesterChatId: conversationExternalId,
    // Member grounding from memberRecord (populated by the verdict consumer).
    requesterContactId: ctx.memberRecord?.contact.id,
    memberStatus: ctx.memberRecord
      ? channelStatusToMemberStatus(ctx.memberRecord.status)
      : undefined,
    memberPolicy: ctx.memberRecord?.policy,
  };
}
