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
