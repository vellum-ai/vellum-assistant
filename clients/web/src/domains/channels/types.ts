import type {
  ChannelsReadinessGetResponse,
  SlackChannelsGetResponse,
} from "@/generated/daemon/types.gen";

// Re-export shared channel types for domain consumers.
export {
  SETUP_CHANNEL_IDS,
  isSetupChannelId,
  type AssistantChannelState,
  type ChannelStatus,
  type SetupChannelId,
} from "@/types/channel-types";

// ---------------------------------------------------------------------------
// Types derived from the generated daemon SDK
// ---------------------------------------------------------------------------

export type SlackChannel = SlackChannelsGetResponse["channels"][number];

type ReadinessSnapshot = ChannelsReadinessGetResponse["snapshots"][number];
export type ChannelReadinessSnapshot = ReadinessSnapshot;
export type ReadinessCheck = NonNullable<ReadinessSnapshot["localChecks"]>[number];
