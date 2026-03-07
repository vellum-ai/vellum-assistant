export const CHANNEL_IDS = [
  "telegram",
  "voice",
  "vellum",
  "whatsapp",
  "slack",
  "email",
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

export function isChannelId(value: unknown): value is ChannelId {
  return (
    typeof value === "string" &&
    (CHANNEL_IDS as readonly string[]).includes(value)
  );
}

/** Legacy channel IDs that were renamed but may still arrive from pre-rename clients. */
const LEGACY_CHANNEL_ALIASES: Record<string, ChannelId> = {
  macos: "vellum",
  ios: "vellum",
};

export function parseChannelId(value: unknown): ChannelId | null {
  if (isChannelId(value)) return value;
  if (typeof value === "string" && value in LEGACY_CHANNEL_ALIASES) {
    return LEGACY_CHANNEL_ALIASES[value]!;
  }
  return null;
}

export function assertChannelId(value: unknown, field: string): ChannelId {
  const parsed = parseChannelId(value);
  if (!parsed) {
    throw new Error(
      `Invalid channel ID for ${field}: ${String(
        value,
      )}. Valid values: ${CHANNEL_IDS.join(", ")}`,
    );
  }
  return parsed;
}

export interface TurnChannelContext {
  userMessageChannel: ChannelId;
  assistantMessageChannel: ChannelId;
}

export const INTERFACE_IDS = [
  "macos",
  "ios",
  "cli",
  "telegram",
  "voice",
  "vellum",
  "whatsapp",
  "slack",
  "email",
] as const;

export type InterfaceId = (typeof INTERFACE_IDS)[number];

export function isInterfaceId(value: unknown): value is InterfaceId {
  return (
    typeof value === "string" &&
    (INTERFACE_IDS as readonly string[]).includes(value)
  );
}

export function parseInterfaceId(value: unknown): InterfaceId | null {
  return isInterfaceId(value) ? value : null;
}

export function assertInterfaceId(value: unknown, field: string): InterfaceId {
  if (!isInterfaceId(value)) {
    throw new Error(
      `Invalid interface ID for ${field}: ${String(
        value,
      )}. Valid values: ${INTERFACE_IDS.join(", ")}`,
    );
  }
  return value;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
