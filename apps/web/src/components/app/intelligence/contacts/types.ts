export type ContactSelection =
  | { kind: "assistant" }
  | { kind: "contact"; contactId: string };

export interface ContactSummary {
  id: string;
  displayName: string;
  role: "guardian" | "assistant" | string;
  contactType?: string | null;
  /** Channel type labels for the sidebar subtitle (e.g. ["Telegram", "Whatsapp"]). */
  channelTypes?: string[];
}

export type ChannelStatus = "ready" | "incomplete" | "not_configured";

export interface AssistantChannelState {
  key: "slack" | "telegram" | "phone";
  status: ChannelStatus;
  address?: string;
  warning?: string;
}
