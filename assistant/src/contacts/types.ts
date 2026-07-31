/** Gateway-sourced: carried on trust verdicts and stamped at the serve layer,
 *  never persisted on the local {@link Contact}. */
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
  createdAt: number;
  updatedAt: number;
  contactType: ContactType;
  /** Workspace-relative path to a per-user persona file for this contact. */
  userFile: string | null;
}

export type ChannelStatus =
  | "active"
  | "pending"
  | "revoked"
  | "blocked"
  | "unverified";
export type ChannelPolicy = "allow" | "deny";

export interface ContactChannel {
  id: string;
  contactId: string;
  type: string; // 'email' | 'slack' | 'whatsapp' | 'phone' | etc.
  address: string;
  isPrimary: boolean;
  externalChatId: string | null;
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

export type ChannelType =
  | "email"
  | "slack"
  | "whatsapp"
  | "phone"
  | "telegram"
  | "discord"
  | "other";
