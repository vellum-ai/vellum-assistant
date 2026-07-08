import type {
  ChannelsAvailableGetResponse,
  ContactsGetResponse,
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

export type ContactPayload = ContactsGetResponse["contacts"][number];
export type ContactChannelPayload = ContactPayload["channels"][number];

export type ChannelInfo = ChannelsAvailableGetResponse["channels"][number];

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
