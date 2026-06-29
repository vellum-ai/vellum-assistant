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
  role: string;
  contactType?: string | null;
  channelTypes?: string[];
}

export type ChannelStatus = "ready" | "incomplete" | "not_configured";

/**
 * Channels that have user-facing setup flows in the UI. Constrained against
 * the generated readiness snapshot type so drift is caught at compile time.
 */
export const SETUP_CHANNEL_IDS = ["slack", "telegram", "phone"] as const satisfies readonly ReadinessSnapshot["channel"][];
export type SetupChannelId = (typeof SETUP_CHANNEL_IDS)[number];

export function isSetupChannelId(value: string): value is SetupChannelId {
  return (SETUP_CHANNEL_IDS as readonly string[]).includes(value);
}

export interface AssistantChannelState {
  key: SetupChannelId;
  status: ChannelStatus;
  address?: string;
  warning?: string;
}
