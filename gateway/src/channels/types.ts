import {
  type ChannelId as CanonicalChannelId,
  type InterfaceId as CanonicalInterfaceId,
  parseInterfaceId as parseCanonicalInterfaceId,
} from "@vellumai/service-contracts/channels";

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
  "discord",
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
] as const satisfies readonly CanonicalInterfaceId[];

export type InterfaceId = (typeof INTERFACE_IDS)[number];

/**
 * Strict type guard for gateway-admitted `InterfaceId` values. Canonical
 * values outside the local subset and legacy aliases like `"vellum"` return
 * `false`; use `parseInterfaceId` to accept and normalize admitted aliases.
 */
export function isInterfaceId(value: unknown): value is InterfaceId {
  return (
    typeof value === "string" &&
    (INTERFACE_IDS as readonly string[]).includes(value)
  );
}

export function parseInterfaceId(value: unknown): InterfaceId | null {
  const canonical = parseCanonicalInterfaceId(value);
  return canonical !== null && isInterfaceId(canonical) ? canonical : null;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
