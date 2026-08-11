/**
 * The per-actor trust context threaded through message handling: the trust
 * classification plus the guardian/requester identity and channel metadata a
 * turn needs. Kept in a leaf module so the many consumers of this shape don't
 * pull in the trust-resolution machinery in `trust-context.ts`.
 */
import type { ChannelConversationType } from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import type { TrustClass } from "../runtime/trust-class.js";

export interface TrustContext {
  /** Channel through which the inbound message arrived. */
  sourceChannel: ChannelId;
  /** Trust classification -- see {@link TrustClass} for semantics. */
  trustClass: TrustClass;
  /** Chat/conversation ID for delivering guardian notifications. */
  guardianChatId?: string;
  /** Canonical external user ID of the guardian for this (assistant, channel) binding. */
  guardianExternalUserId?: string;
  /** Internal principal ID of the guardian. */
  guardianPrincipalId?: string;
  /** Human-readable identifier for the requester (e.g. @username or phone number). */
  requesterIdentifier?: string;
  /** Preferred display name for the requester (member name or sender name). */
  requesterDisplayName?: string;
  /** Raw sender display name as provided by the channel transport. */
  requesterSenderDisplayName?: string;
  /** Guardian-managed display name from the contact record. */
  requesterMemberDisplayName?: string;
  /** Raw timezone for the requester, when supplied by the source channel. */
  requesterTimezone?: string;
  /** Compact timezone label for the requester, when supplied by the source channel. */
  requesterTimezoneLabel?: string;
  /** Raw timezone offset in seconds for the requester, when supplied by the source channel. */
  requesterTimezoneOffsetSeconds?: number;
  /** Canonical external user ID of the requester (the current actor). */
  requesterExternalUserId?: string;
  /** Chat/conversation ID the requester is interacting through. */
  requesterChatId?: string;
  /**
   * Channel-native id (`ts` for Slack) of the inbound message that started
   * the current turn. Stamped at ingress so guardian-approval producers can
   * link approval cards to the exact triggering message.
   */
  sourceMessageId?: string;
  /** Channel-native thread id of that message, when it arrived in a thread. */
  sourceThreadId?: string;
  /**
   * Conversation type of the inbound chat mapped onto the permission-matrix
   * axis (`dm | private | public`). Undefined when the channel's chat type is
   * unknown or ambiguous — the matrix's channel-type tier then cannot match
   * and resolution falls through to the adapter tier (fail-safe direction).
   */
  conversationType?: ChannelConversationType;
  /** Contact ID of the requester's member record, for local info joins. */
  requesterContactId?: string;
  /** API-facing member status of the requester's channel (ACL). */
  memberStatus?: string;
  /** Channel policy of the requester's channel (ACL). */
  memberPolicy?: string;
  /**
   * Prior-interaction count for the requester's member channel, sourced from
   * the gateway trust verdict (gateway owns interaction telemetry). Undefined
   * when the verdict carries no member telemetry (unknown sender) or when trust
   * was resolved locally without a gateway verdict.
   */
  requesterInteractionCount?: number;
}

/**
 * Whether two trust contexts describe the same acting identity at the same
 * privilege, for callers that may only run work under one of them (batched
 * turns being the case that matters).
 *
 * Compares the privilege (`trustClass`), the channel a grant is scoped to
 * (`sourceChannel`), and every field that can carry who the actor is. The
 * identity fields are covered exhaustively rather than by picking the usual
 * ones: an ingress that populates only `requesterIdentifier` or
 * `requesterContactId` would otherwise leave two distinct senders comparing
 * equal on a pair of undefineds, which is the exact case this guards.
 *
 * Deliberately conservative: an absent field never matches a present one, so
 * unknown identities are treated as distinct. Answering "different" when they
 * match only costs a batching opportunity; answering "same" when they differ
 * runs one actor's work under another's privileges.
 */
export function sameTrustIdentity(
  a: TrustContext | undefined,
  b: TrustContext | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.trustClass === b.trustClass &&
    a.sourceChannel === b.sourceChannel &&
    a.requesterExternalUserId === b.requesterExternalUserId &&
    a.requesterChatId === b.requesterChatId &&
    a.requesterIdentifier === b.requesterIdentifier &&
    a.requesterContactId === b.requesterContactId &&
    a.guardianExternalUserId === b.guardianExternalUserId &&
    a.guardianPrincipalId === b.guardianPrincipalId
  );
}

/** The two trust fields a conversation-shaped value carries. */
export interface TrustCarrier {
  currentTurnTrustContext?: TrustContext;
  trustContext?: TrustContext;
}

/**
 * The acting turn's trust, else the owner's. Structural counterpart of
 * `Conversation.getTurnOrRestingTrust` for call sites handed a
 * conversation-shaped context rather than the class, so a partial test double
 * needs only the fields it already has.
 */
export function turnOrRestingTrust(
  carrier: TrustCarrier | undefined,
): TrustContext | undefined {
  return carrier?.currentTurnTrustContext ?? carrier?.trustContext;
}

/**
 * The owner's trust, independent of any turn. Structural counterpart of
 * `Conversation.getTrustContext`; see `docs/architecture/turn-actor.md` for
 * when the owner is the right actor.
 */
export function restingTrust(
  carrier: Pick<TrustCarrier, "trustContext"> | undefined,
): TrustContext | undefined {
  return carrier?.trustContext;
}
