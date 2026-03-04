export type ContactRole = "guardian" | "contact";

export interface Contact {
  id: string;
  displayName: string;
  relationship: string | null;
  importance: number;
  responseExpectation: string | null;
  preferredTone: string | null;
  lastInteraction: number | null;
  interactionCount: number;
  createdAt: number;
  updatedAt: number;
  role: ContactRole;
  principalId: string | null;
  assistantId: string | null;
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
