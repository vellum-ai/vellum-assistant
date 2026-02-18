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
}

export interface ContactChannel {
  id: string;
  contactId: string;
  type: string;       // 'email' | 'slack' | 'whatsapp' | 'phone' | etc.
  address: string;
  isPrimary: boolean;
  createdAt: number;
}

export interface ContactWithChannels extends Contact {
  channels: ContactChannel[];
}

export const CHANNEL_TYPES = ['email', 'slack', 'whatsapp', 'phone', 'telegram', 'discord', 'other'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
