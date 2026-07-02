/**
 * Consume a gateway-stamped {@link TrustVerdict} into the daemon's local
 * trust shapes.
 *
 * The gateway resolves a per-actor verdict from its ACL DB and stamps it onto
 * inbound `sourceMetadata`. These pure mappers turn that verdict into the same
 * {@link TrustContext} the local resolver would have produced — ACL + identity
 * only. INFO fields (notes, userFile, contactType, interactionCount) are never
 * carried on the wire; the consumer re-joins them locally by contactId.
 */

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import { channelStatusToMemberStatus } from "../contacts/member-status.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactChannel,
  ContactRole,
  ContactWithChannels,
} from "../contacts/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { ActorTrustContext } from "./actor-trust-resolver.js";
import { toTrustContext } from "./actor-trust-resolver.js";

export interface TrustVerdictTransport {
  sourceChannel: ChannelId;
  conversationExternalId: string;
  actorUsername?: string;
  actorDisplayName?: string;
}

/**
 * Reassemble an {@link ActorTrustContext} from a gateway verdict + transport
 * identity (mirroring `resolveActorTrust`), without any local DB/IPC reads.
 *
 * Pure: the voice path consumes this directly for routing on
 * `actorTrust.trustClass`; {@link trustContextFromVerdict} routes it through
 * {@link toTrustContext}.
 */
export function actorTrustContextFromVerdict(
  verdict: TrustVerdict,
  input: TrustVerdictTransport,
): ActorTrustContext {
  const canonicalSenderId = verdict.canonicalSenderId;
  const memberDisplayName = verdict.memberDisplayName;
  const senderDisplayName = input.actorDisplayName;
  const username = input.actorUsername;
  const identifier = username
    ? `@${username}`
    : (canonicalSenderId ?? undefined);

  return {
    canonicalSenderId,
    guardianBindingMatch: verdict.guardianExternalUserId
      ? {
          guardianExternalUserId: verdict.guardianExternalUserId,
          guardianDeliveryChatId: verdict.guardianDeliveryChatId ?? null,
        }
      : null,
    guardianPrincipalId: verdict.guardianPrincipalId,
    // Populate from the verdict so the voice path's ACL gates (which read
    // actorTrust.memberRecord.channel status/policy) enforce blocked/revoked/
    // deny/escalate. Null for memberless verdicts. Text path is unaffected:
    // toTrustContext derives the same member fields trustContextFromVerdict
    // already stamps.
    memberRecord: memberRecordFromVerdict(verdict),
    trustClass: verdict.trustClass,
    actorMetadata: {
      identifier,
      displayName: memberDisplayName ?? senderDisplayName,
      senderDisplayName,
      memberDisplayName,
      username,
      channel: input.sourceChannel,
      trustStatus: verdict.trustClass,
    },
  };
}

/**
 * Build a {@link TrustContext} from a gateway verdict + transport identity.
 *
 * Reassembles an {@link ActorTrustContext} (mirroring `resolveActorTrust`) and
 * routes it through {@link toTrustContext}, so the output is byte-identical to
 * the local resolution path.
 */
export function trustContextFromVerdict(
  verdict: TrustVerdict,
  input: TrustVerdictTransport,
): TrustContext {
  const context = toTrustContext(
    actorTrustContextFromVerdict(verdict, input),
    input.conversationExternalId,
  );

  // Stamp the verdict's ACL member fields onto the context so downstream turn
  // assembly reads member status/policy from the verdict rather than a local
  // re-resolution. The contact ID anchors the local info-only join.
  const member = verdictMemberFromVerdict(verdict);
  if (member) {
    context.requesterContactId = member.contactId;
    context.memberStatus = channelStatusToMemberStatus(member.status);
    context.memberPolicy = member.policy;
  }

  // Interaction telemetry is gateway-owned: carry the verdict's count straight
  // through so turn assembly reads it from the verdict rather than the local
  // assistant DB.
  if (verdict.interactionCount !== undefined) {
    context.requesterInteractionCount = verdict.interactionCount;
  }

  return context;
}

/**
 * True when the verdict carries a member identity (contactId or channelId),
 * regardless of whether that member resolves to a usable {@link VerdictMember}.
 */
export function verdictHasMemberIdentity(verdict: TrustVerdict): boolean {
  return !!(verdict.contactId || verdict.channelId);
}

/**
 * True when the verdict claims a member identity but that member can't be
 * resolved (partial/mixed-version verdict). Such a verdict is unusable —
 * callers fall back to local resolution.
 */
export function verdictMemberUnresolvable(verdict: TrustVerdict): boolean {
  return (
    verdictHasMemberIdentity(verdict) &&
    verdictMemberFromVerdict(verdict) === null
  );
}

// Allowed ACL enum values, kept in sync with the ContactChannel union types.
const CHANNEL_STATUS_VALUES: readonly ChannelStatus[] = [
  "active",
  "pending",
  "revoked",
  "blocked",
  "unverified",
];
const CHANNEL_POLICY_VALUES: readonly ChannelPolicy[] = [
  "allow",
  "deny",
  "escalate",
];

function isChannelStatus(value: string): value is ChannelStatus {
  return (CHANNEL_STATUS_VALUES as readonly string[]).includes(value);
}

function isChannelPolicy(value: string): value is ChannelPolicy {
  return (CHANNEL_POLICY_VALUES as readonly string[]).includes(value);
}

/**
 * The ACL fields a gateway verdict carries for a resolved member, decoupled
 * from the schema-derived {@link ContactChannel}.
 */
export interface VerdictMember {
  contactId: string;
  channelId: string;
  status: ChannelStatus;
  policy: ChannelPolicy;
  verifiedAt: number | null;
  displayName: string | null;
}

/**
 * Extract the narrow {@link VerdictMember} ACL view from a gateway verdict.
 *
 * Guards on contactId/channelId presence + known status/policy enums, failing
 * closed to null otherwise.
 */
export function verdictMemberFromVerdict(
  verdict: TrustVerdict,
): VerdictMember | null {
  if (!verdict.contactId || !verdict.channelId) return null;
  if (!verdict.status || !verdict.policy) return null;
  if (!isChannelStatus(verdict.status) || !isChannelPolicy(verdict.policy)) {
    return null;
  }

  return {
    contactId: verdict.contactId,
    channelId: verdict.channelId,
    status: verdict.status,
    policy: verdict.policy,
    verifiedAt: verdict.verifiedAt ?? null,
    displayName: verdict.memberDisplayName ?? null,
  };
}

/**
 * Build the voice-path {@link ActorTrustContext.memberRecord} from a gateway
 * verdict's narrow ACL view.
 *
 * ACL + identity only; info fields are placeholders, re-joined locally by
 * contactId. Returns null for memberless/unresolvable verdicts.
 */
function memberRecordFromVerdict(
  verdict: TrustVerdict,
): ActorTrustContext["memberRecord"] {
  const member = verdictMemberFromVerdict(verdict);
  if (!member) return null;

  const channel: ContactChannel = {
    id: member.channelId,
    contactId: member.contactId,
    type: verdict.type ?? "",
    address: verdict.address ?? "",
    isPrimary: false,
    externalChatId: verdict.externalChatId ?? null,
    lastSeenAt: null,
    interactionCount: 0,
    lastInteraction: null,
    updatedAt: null,
    createdAt: 0,
  };

  const role: ContactRole =
    verdict.trustClass === "guardian" ? "guardian" : "contact";

  const contact: ContactWithChannels = {
    id: member.contactId,
    displayName: member.displayName ?? "",
    notes: null,
    role,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    contactType: "human",
    userFile: null,
    channels: [channel],
  };

  return {
    contact,
    channel,
    status: member.status,
    policy: member.policy,
    role,
  };
}
