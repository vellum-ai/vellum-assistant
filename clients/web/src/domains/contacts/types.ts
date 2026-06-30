import type {
  ChannelsAvailableGetResponse,
  ChannelsReadinessGetResponse,
  ContactsGetResponse,
} from "@/generated/daemon/types.gen";
import type { SetupChannelId } from "@/types/channel-types";

// Re-export shared channel types for domain consumers.
export { SETUP_CHANNEL_IDS, isSetupChannelId, type SetupChannelId } from "@/types/channel-types";

// ---------------------------------------------------------------------------
// Types derived from the generated daemon SDK
// ---------------------------------------------------------------------------

export type ContactPayload = ContactsGetResponse["contacts"][number];
export type ContactChannelPayload = ContactPayload["channels"][number];

export type ChannelInfo = ChannelsAvailableGetResponse["channels"][number];

type ReadinessSnapshot = ChannelsReadinessGetResponse["snapshots"][number];
export type ChannelReadinessSnapshot = ReadinessSnapshot;
export type ReadinessCheck = NonNullable<ReadinessSnapshot["localChecks"]>[number];

// ---------------------------------------------------------------------------
// UI-only types (no daemon/gateway equivalent)
// ---------------------------------------------------------------------------

export type ContactSelection =
  | { kind: "assistant" }
  | { kind: "contact"; contactId: string };

export interface ContactSummary {
  id: string;
  displayName: string;
  role: string;
  contactType?: string | null;
  channelTypes?: string[];
}

export type ChannelStatus = "ready" | "incomplete" | "not_configured";

export interface AssistantChannelState {
  key: SetupChannelId;
  status: ChannelStatus;
  address?: string;
  warning?: string;
}
