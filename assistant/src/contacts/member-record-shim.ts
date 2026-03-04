/**
 * Synthesize an IngressMember-compatible record from a Contact + ContactChannel.
 * This shim enables callers to adopt contacts-first lookups without changing
 * the IngressMember interface or downstream consumers.
 *
 * Also serves as the canonical home for the IngressMember, MemberStatus, and
 * MemberPolicy type definitions (migrated from the deleted ingress-member-store).
 */
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import type { ContactChannel, ContactWithChannels } from "./types.js";

// ---------------------------------------------------------------------------
// Types (formerly in memory/ingress-member-store.ts)
// ---------------------------------------------------------------------------

export type MemberStatus = "pending" | "active" | "revoked" | "blocked";
export type MemberPolicy = "allow" | "deny" | "escalate";

export interface IngressMember {
  id: string;
  assistantId: string;
  sourceChannel: string;
  externalUserId: string | null;
  externalChatId: string | null;
  displayName: string | null;
  username: string | null;
  status: MemberStatus;
  policy: MemberPolicy;
  inviteId: string | null;
  createdBySessionId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}

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
