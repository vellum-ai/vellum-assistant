import type { ChannelId as CanonicalChannelId } from "@vellumai/service-contracts/channels";

/**
 * Channels the gateway can ingress — a strict subset of the canonical
 * `ChannelId` set. The gateway never sees `platform` (internal control plane),
 * and the admission-policy routes rely on that omission: a request for a
 * `platform` policy fails the `isChannelId` gate and returns 403. The
 * `satisfies` clause asserts every entry is a real canonical channel, so the
 * gateway can never list one the assistant doesn't recognize.
 */
export const CHANNEL_IDS = [
  "telegram",
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "a2a",
] as const satisfies readonly CanonicalChannelId[];

export type ChannelId = (typeof CHANNEL_IDS)[number];

export function isChannelId(value: unknown): value is ChannelId {
  return (
    typeof value === "string" &&
    (CHANNEL_IDS as readonly string[]).includes(value)
  );
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
  "a2a",
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
