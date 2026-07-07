/**
 * Room-scoped resolved-access vocabulary for channel adapters' room lists:
 * the badge each room (channel, group, DM) shows for how inbound messages
 * from it are admitted. Channel-agnostic — each adapter derives a
 * {@link ResolvedRoomAccess} from its own room shape (Slack:
 * `resolveSlackChannelAccess` in the Slack channel list) and renders it with
 * the shared labels/tones here so badges read identically across channels.
 */
import type { TagTone } from "@vellumai/design-library/components/tag";

/**
 * `full_access`: messages from this room reach the assistant at full trust.
 * `strict`: senders in this room must verify before they get through.
 */
export type ResolvedRoomAccess = "full_access" | "strict";

export const RESOLVED_ROOM_ACCESS_LABELS: Record<ResolvedRoomAccess, string> = {
  full_access: "Full access",
  strict: "Strict",
};

export const RESOLVED_ROOM_ACCESS_TONES: Record<ResolvedRoomAccess, TagTone> = {
  full_access: "positive",
  strict: "negative",
};
