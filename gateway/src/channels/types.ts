export const CHANNEL_IDS = [
  'telegram', 'sms', 'voice', 'vellum', 'whatsapp', 'slack', 'email', 'assistant',
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

export const INTERFACE_IDS = [
  'macos', 'ios', 'cli',
  'telegram', 'sms', 'voice', 'vellum', 'whatsapp', 'slack', 'email', 'assistant',
] as const;

export type InterfaceId = (typeof INTERFACE_IDS)[number];

export function isInterfaceId(value: unknown): value is InterfaceId {
  return typeof value === 'string' && (INTERFACE_IDS as readonly string[]).includes(value);
}

export function parseInterfaceId(value: unknown): InterfaceId | null {
  return isInterfaceId(value) ? value : null;
}

export function assertInterfaceId(value: unknown, field: string): InterfaceId {
  if (!isInterfaceId(value)) {
    throw new Error(`Invalid interface ID for ${field}: ${String(value)}. Valid values: ${INTERFACE_IDS.join(', ')}`);
  }
  return value;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
