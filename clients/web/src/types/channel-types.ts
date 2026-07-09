import type { ChannelsReadinessGetResponse } from "@/generated/daemon/types.gen";

export type ChannelReadinessSnapshot =
  ChannelsReadinessGetResponse["snapshots"][number];

/**
 * Channels that have user-facing setup flows in the UI. Constrained against
 * the generated readiness snapshot type so drift is caught at compile time.
 */
export const SETUP_CHANNEL_IDS = [
  "slack",
  "telegram",
  "phone",
] as const satisfies readonly ChannelReadinessSnapshot["channel"][];
export type SetupChannelId = (typeof SETUP_CHANNEL_IDS)[number];

export function isSetupChannelId(value: string): value is SetupChannelId {
  return (SETUP_CHANNEL_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Channel setup state (UI-only; shared by the Channels tab and the Contacts
// assistant detail)
// ---------------------------------------------------------------------------

export type ChannelStatus = "ready" | "incomplete" | "not_configured";

export interface AssistantChannelState {
  key: SetupChannelId;
  status: ChannelStatus;
  address?: string;
  warning?: string;
}
