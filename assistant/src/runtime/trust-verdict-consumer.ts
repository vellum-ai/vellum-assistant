/**
 * Consume a gateway-stamped {@link TrustVerdict} into the daemon's local
 * trust shapes.
 *
 * The gateway resolves a per-actor verdict from its ACL DB and stamps it onto
 * inbound `sourceMetadata`. These pure mappers turn that verdict into the same
 * {@link TrustContext} / {@link ResolvedMember} the local resolver would have
 * produced — ACL + identity only. INFO fields (notes, userFile, contactType,
 * interactionCount) are never carried on the wire; the consumer re-joins them
 * locally by contactId.
 */

import type { TrustVerdict } from "@vellumai/gateway-client";

import type { ChannelId } from "../channels/types.js";
import type {
  ChannelPolicy,
  ChannelStatus,
  ContactChannel,
  ContactWithChannels,
} from "../contacts/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { ActorTrustContext } from "./actor-trust-resolver.js";
import { toTrustContext } from "./actor-trust-resolver.js";
import {
  channelStatusToMemberStatus,
  type ResolvedMember,
} from "./routes/inbound-stages/acl-enforcement.js";

export interface TrustVerdictTransport {
  sourceChannel: ChannelId;
  conversationExternalId: string;
  actorUsername?: string;
  actorDisplayName?: string;
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
  const canonicalSenderId = verdict.canonicalSenderId;
  const memberDisplayName = verdict.memberDisplayName;
  const senderDisplayName = input.actorDisplayName;
  const username = input.actorUsername;
  const identifier = username
    ? `@${username}`
    : (canonicalSenderId ?? undefined);

  const actorTrustContext: ActorTrustContext = {
    canonicalSenderId,
    guardianBindingMatch: verdict.guardianExternalUserId
      ? {
          guardianExternalUserId: verdict.guardianExternalUserId,
          guardianDeliveryChatId: verdict.guardianDeliveryChatId ?? null,
        }
      : null,
    guardianPrincipalId: verdict.guardianPrincipalId,
    memberRecord: null,
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

  const context = toTrustContext(
    actorTrustContext,
    input.conversationExternalId,
  );

  // Stamp the verdict's ACL member fields onto the context so downstream turn
  // assembly reads member status/policy from the verdict rather than a local
  // re-resolution. The contact ID anchors the local info-only join.
  const member = resolvedMemberFromVerdict(verdict);
  if (member) {
    context.requesterContactId = member.contact.id;
    context.memberStatus = channelStatusToMemberStatus(member.channel.status);
    context.memberPolicy = member.channel.policy;
  }

  return context;
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
 * Build a synthetic {@link ResolvedMember} from a gateway verdict.
 *
 * ACL + identity only; info fields are placeholders, re-joined locally by
 * contactId. Returns null for memberless verdicts.
 */
export function resolvedMemberFromVerdict(
  verdict: TrustVerdict,
): ResolvedMember | null {
  if (!verdict.contactId || !verdict.channelId) return null;
  // Member verdict requires valid known status+policy enums, else null
  // (fail-closed): a partial/mixed-version verdict (absent OR
  // present-but-unknown ACL value) must not synthesize an active/allow channel
  // that would skip ingress ACL gates.
  if (!verdict.status || !verdict.policy) return null;
  if (!isChannelStatus(verdict.status) || !isChannelPolicy(verdict.policy)) {
    return null;
  }

  const channel: ContactChannel = {
    id: verdict.channelId,
    contactId: verdict.contactId,
    type: verdict.type ?? "",
    address: verdict.address ?? "",
    isPrimary: false,
    externalChatId: verdict.externalChatId ?? null,
    status: verdict.status,
    policy: verdict.policy,
    verifiedAt: verdict.verifiedAt ?? null,
    verifiedVia: verdict.verifiedVia ?? null,
    inviteId: null,
    revokedReason: null,
    blockedReason: null,
    lastSeenAt: null,
    interactionCount: 0,
    lastInteraction: null,
    updatedAt: null,
    createdAt: 0,
  };

  const contact: ContactWithChannels = {
    id: verdict.contactId,
    displayName: verdict.memberDisplayName ?? "",
    notes: null,
    lastInteraction: null,
    interactionCount: 0,
    createdAt: 0,
    updatedAt: 0,
    role: verdict.trustClass === "guardian" ? "guardian" : "contact",
    contactType: "human",
    principalId: verdict.guardianPrincipalId ?? null,
    userFile: null,
    channels: [channel],
  };

  return { contact, channel };
}
