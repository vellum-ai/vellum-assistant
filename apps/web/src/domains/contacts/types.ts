export type ContactChannelType = "slack" | "telegram" | "phone" | "email" | string;

export interface ChannelInfo {
  id: string;
  label: string;
  subtitle: string;
  /** Lucide icon name in kebab-case (e.g. "hash", "send", "message-square"). */
  icon: string;
  supportsVerification: boolean;
  setupMessages: {
    guardian: string;
    contact: string;
  };
}

export interface ContactChannelPayload {
  id: string;
  type: ContactChannelType;
  address: string;
  isPrimary: boolean;
  externalUserId?: string | null;
  status: string;
  policy: string;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
  lastSeenAt?: number | null;
  interactionCount?: number | null;
  lastInteraction?: number | null;
  revokedReason?: string | null;
  blockedReason?: string | null;
}

export interface ContactPayload {
  id: string;
  displayName: string;
  role: string;
  notes?: string | null;
  contactType?: string | null;
  lastInteraction?: number | null;
  interactionCount: number;
  channels: ContactChannelPayload[];
}

export interface ReadinessCheck {
  name: string;
  passed: boolean;
  message?: string | null;
}

export interface ChannelReadinessSnapshot {
  channel: "slack" | "telegram" | "phone" | string;
  ready: boolean;
  setupStatus?: "ready" | "incomplete" | "not_configured" | string | null;
  channelHandle?: string | null;
  localChecks?: ReadinessCheck[];
  remoteChecks?: ReadinessCheck[];
}

export interface SlackChannelConfig {
  hasBotToken?: boolean;
  hasAppToken?: boolean;
  connected?: boolean;
  botUsername?: string | null;
  botUserId?: string | null;
  teamId?: string | null;
  teamName?: string | null;
}

export interface NewContactChannelInput {
  type: ContactChannelType;
  address: string;
  isPrimary?: boolean;
}

export interface CreateContactInput {
  displayName: string;
  notes?: string;
  channels?: NewContactChannelInput[];
}

export interface TelegramConfig {
  success: boolean;
  hasBotToken: boolean;
  botId?: string | null;
  botUsername?: string | null;
  connected: boolean;
}

export interface TwilioConfig {
  success: boolean;
  hasCredentials: boolean;
  accountSid?: string;
  phoneNumber?: string;
}

export interface TwilioPhoneNumber {
  phoneNumber: string;
  friendlyName: string;
}

export interface ConnectAssistantInput {
  guardianHandle: string;
  gatewayUrl: string;
}

export interface ConnectAssistantResponse {
  success: boolean;
  contactId: string;
  alreadyConnected?: boolean;
  error?: string;
}

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
