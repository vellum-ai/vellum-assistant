import type { ChannelStatus } from "./types.js";

/** Map ChannelStatus to the API-facing member status (excludes "unverified"). */
export function channelStatusToMemberStatus(
  status: ChannelStatus,
): Exclude<ChannelStatus, "unverified"> {
  if (status === "unverified") return "pending";
  return status;
}
