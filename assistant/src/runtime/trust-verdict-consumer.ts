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
import type { ContactChannel, ContactWithChannels } from "../contacts/types.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { ActorTrustContext } from "./actor-trust-resolver.js";
import { toTrustContext } from "./actor-trust-resolver.js";
import type { ResolvedMember } from "./routes/inbound-stages/acl-enforcement.js";

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

  return toTrustContext(actorTrustContext, input.conversationExternalId);
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

  const channel: ContactChannel = {
    id: verdict.channelId,
    contactId: verdict.contactId,
    type: verdict.type ?? "",
    address: verdict.address ?? "",
    isPrimary: false,
    externalChatId: verdict.externalChatId ?? null,
    status: (verdict.status ?? "active") as ContactChannel["status"],
    policy: (verdict.policy ?? "allow") as ContactChannel["policy"],
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
