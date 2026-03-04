/**
 * Synthesize an IngressMember-compatible record from a Contact + ContactChannel.
 * This shim enables callers to adopt contacts-first lookups without changing
 * the IngressMember interface or downstream consumers.
 */
import type { IngressMember } from "../memory/ingress-member-store.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import type { ContactChannel, ContactWithChannels } from "./types.js";

export function contactChannelToMemberRecord(
  contact: ContactWithChannels,
  channel: ContactChannel,
): IngressMember {
  return {
    id: channel.id,
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    sourceChannel: channel.type,
    externalUserId: channel.externalUserId,
    externalChatId: channel.externalChatId,
    displayName: contact.displayName,
    username: null,
    status:
      channel.status === "active"
        ? "active"
        : channel.status === "pending"
          ? "pending"
          : channel.status === "unverified"
            ? "pending"
            : channel.status === "revoked"
              ? "revoked"
              : channel.status === "blocked"
                ? "blocked"
                : "active",
    policy: channel.policy,
    inviteId: channel.inviteId,
    createdBySessionId: null,
    revokedReason: channel.revokedReason,
    blockedReason: channel.blockedReason,
    lastSeenAt: channel.lastSeenAt,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt ?? channel.createdAt,
  };
}
