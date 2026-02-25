export const CHANNEL_IDS = [
  'telegram', 'sms', 'voice', 'vellum', 'whatsapp', 'slack', 'email',
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === 'string' && (CHANNEL_IDS as readonly string[]).includes(value);
}

export function parseChannelId(value: unknown): ChannelId | null {
  return isChannelId(value) ? value : null;
}

export function assertChannelId(value: unknown, field: string): ChannelId {
  if (!isChannelId(value)) {
    throw new Error(`Invalid channel ID for ${field}: ${String(value)}. Valid values: ${CHANNEL_IDS.join(', ')}`);
  }
  return value;
}

export interface TurnChannelContext {
  userMessageChannel: ChannelId;
  assistantMessageChannel: ChannelId;
}
