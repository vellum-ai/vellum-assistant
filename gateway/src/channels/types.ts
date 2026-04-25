export const CHANNEL_IDS = [
  "telegram",
  "phone",
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

export function parseChannelId(value: unknown): ChannelId | null {
  return isChannelId(value) ? value : null;
}

export const INTERFACE_IDS = [
  "macos",
  "ios",
  "cli",
  "telegram",
  "phone",
  "web",
  "whatsapp",
  "slack",
  "email",
] as const;

export type InterfaceId = (typeof INTERFACE_IDS)[number];

/**
 * Interface IDs that older clients or persisted data may still use.
 * Maps legacy values to their canonical replacements.
 */
const LEGACY_INTERFACE_ALIASES: Record<string, InterfaceId> = {
  // The web client used to report "vellum" as its interface ID.
  vellum: "web",
};

/**
 * Strict type guard — returns `true` only for canonical `InterfaceId`
 * values. Legacy aliases like `"vellum"` return `false`; use
 * `parseInterfaceId` to accept and normalize those.
 */
export function isInterfaceId(value: unknown): value is InterfaceId {
  return (
    typeof value === "string" &&
    (INTERFACE_IDS as readonly string[]).includes(value)
  );
}

export function normalizeInterfaceId(value: InterfaceId): InterfaceId {
  return (LEGACY_INTERFACE_ALIASES[value] as InterfaceId) ?? value;
}

export function parseInterfaceId(value: unknown): InterfaceId | null {
  if (typeof value !== "string") return null;
  if ((INTERFACE_IDS as readonly string[]).includes(value))
    return value as InterfaceId;
  const alias = LEGACY_INTERFACE_ALIASES[value];
  if (alias) return alias;
  return null;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
