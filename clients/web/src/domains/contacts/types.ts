import type {
  ChannelsAvailableGetResponse,
  ContactsGetResponse,
} from "@/generated/daemon/types.gen";

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

export interface ContactSummary extends Pick<
  ContactPayload,
  "id" | "displayName" | "role"
> {
  contactType?: ContactPayload["contactType"] | null;
  channelTypes?: string[]; // client-only display labels, not on the wire
}
