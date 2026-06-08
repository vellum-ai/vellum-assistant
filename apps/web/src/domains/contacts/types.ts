import type {
  ChannelsAvailableGetResponse,
  ChannelsReadinessGetResponse,
  ContactsGetResponse,
} from "@/generated/daemon/types.gen";

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
  role: "guardian" | "assistant" | string;
  contactType?: string | null;
  channelTypes?: string[];
}

export type ChannelStatus = "ready" | "incomplete" | "not_configured";

export interface AssistantChannelState {
  key: "slack" | "telegram" | "phone";
  status: ChannelStatus;
  address?: string;
  warning?: string;
}
