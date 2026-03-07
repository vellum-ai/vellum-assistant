export type ContactRole = "guardian" | "contact";

export type ContactType = "human" | "assistant";

export type AssistantSpecies = "vellum" | "openclaw";

export interface VellumAssistantMetadata {
  assistantId: string;
  gatewayUrl: string;
}

export interface OpenClawAssistantMetadata {
  [key: string]: unknown;
}

export type AssistantContactMetadata =
  | {
      contactId: string;
      species: "vellum";
      metadata: VellumAssistantMetadata | null;
    }
  | {
      contactId: string;
      species: "openclaw";
      metadata: OpenClawAssistantMetadata | null;
    };

export interface Contact {
  id: string;
  displayName: string;
  /** Free-text notes about this contact (e.g. relationship, communication preferences). */
  notes: string | null;
  lastInteraction: number | null;
  interactionCount: number;
  createdAt: number;
  updatedAt: number;
  role: ContactRole;
  contactType: ContactType;
  /**
   * Internal auth identity (e.g. "vellum-principal-<uuid>"). Only meaningful
   * for guardian contacts — it ties the contact record to the auth layer so
   * the system can verify "this API caller IS this guardian" via JWT
   * actorPrincipalId. Always null for non-guardian contacts, which are
   * identified by channel address instead.
   */
  principalId: string | null;
}

export type ChannelStatus =
  | "active"
  | "pending"
  | "revoked"
  | "blocked"
  | "unverified";
export type ChannelPolicy = "allow" | "deny" | "escalate";

export interface ContactChannel {
  id: string;
  contactId: string;
  type: string; // 'email' | 'slack' | 'whatsapp' | 'phone' | etc.
  address: string;
  isPrimary: boolean;
  externalUserId: string | null;
  externalChatId: string | null;
  status: ChannelStatus;
  policy: ChannelPolicy;
  verifiedAt: number | null;
  verifiedVia: string | null;
  inviteId: string | null;
  revokedReason: string | null;
  blockedReason: string | null;
  lastSeenAt: number | null;
  updatedAt: number | null;
  createdAt: number;
}

export interface ContactWithChannels extends Contact {
  channels: ContactChannel[];
}

export interface ContactWriteResult {
  contact: ContactWithChannels;
  channel: ContactChannel;
}

export const CHANNEL_TYPES = [
  "email",
  "slack",
  "whatsapp",
  "phone",
  "telegram",
  "discord",
  "other",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
