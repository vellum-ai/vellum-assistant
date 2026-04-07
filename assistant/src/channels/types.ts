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
  if (isChannelId(value)) return value;
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
  "phone",
  "vellum",
  "whatsapp",
  "slack",
  "email",
  "chrome-extension",
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

/**
 * Interfaces that have an SSE client capable of displaying interactive
 * permission prompts. Channel interfaces (telegram, slack, etc.) route
 * approvals through the guardian system and have no interactive prompter UI.
 */
export const INTERACTIVE_INTERFACES: ReadonlySet<InterfaceId> = new Set([
  "macos",
  "ios",
  "cli",
  "vellum",
]);

export function isInteractiveInterface(id: InterfaceId): boolean {
  return INTERACTIVE_INTERFACES.has(id);
}

/**
 * Host proxy capabilities that an interface can support. The macOS client
 * historically supports all four; the chrome-extension interface only
 * supports host_browser (via the Chrome DevTools Protocol proxy).
 */
export type HostProxyCapability =
  | "host_bash"
  | "host_file"
  | "host_cu"
  | "host_browser";

/**
 * Whether the interface supports a host proxy capability. Omit `capability`
 * to ask "does this interface support any host proxy at all?" — the macOS
 * client historically supports all four capabilities; the chrome-extension
 * interface only supports host_browser, so the no-arg form returns `false`
 * for chrome-extension.
 */
export function supportsHostProxy(
  id: InterfaceId,
  capability?: HostProxyCapability,
): boolean {
  if (id === "macos") return true;
  if (id === "chrome-extension" && capability === "host_browser") return true;
  return false;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
