import type { ChannelStatus } from "./types.js";

/** Map ChannelStatus to the API-facing member status (excludes "unverified"). */
export function channelStatusToMemberStatus(
  status: ChannelStatus,
): Exclude<ChannelStatus, "unverified"> {
  if (status === "unverified") {
    return "pending";
  }
  return status;
}

/**
 * Whether a contact channel status is a deliberate keep-out — a contact the
 * guardian revoked or blocked.
 *
 * This is the durable source of truth for suppressing re-engagement: a
 * kept-out sender's re-contact must not re-notify the guardian or mint a fresh
 * self-verify challenge. A parked `unverified` contact is deliberately NOT
 * kept out — it is a neutral park, so a later inbound that needs trust must
 * re-fire the introduction flow. The transient guardian-request status is not
 * consulted; the contact's standing is. Accepts both the raw `ChannelStatus`
 * and the API-facing member status (from {@link channelStatusToMemberStatus})
 * — `revoked` and `blocked` are members of both — plus `undefined` for a
 * sender with no contact record, which is never kept out.
 */
export function isKeptOutStatus(status: ChannelStatus | undefined): boolean {
  return status === "revoked" || status === "blocked";
}
