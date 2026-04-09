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
 * supports all four; the chrome-extension interface only supports
 * host_browser (via the Chrome DevTools Protocol proxy).
 */
export type HostProxyCapability =
  | "host_bash"
  | "host_file"
  | "host_cu"
  | "host_browser";

/**
 * Interfaces that support the full desktop host-proxy set (all four
 * `HostProxyCapability` values). This is the capability-level identity used
 * by the discriminated transport metadata union and by the
 * `supportsHostProxy(id)` type predicate.
 *
 * Extend this literal type AND the `supportsHostProxy` implementation
 * below in lock-step when adding a new host-capable client (e.g. a native
 * Linux or Windows desktop).
 */
export type HostProxyInterfaceId = "macos";

/**
 * Whether the interface supports a host proxy capability.
 *
 * The no-arg form `supportsHostProxy(id)` asks "is this interface a desktop
 * host-proxy client?" — it returns `true` only for macOS and is the type
 * predicate that narrows `InterfaceId` to `HostProxyInterfaceId`. It returns
 * `false` for chrome-extension because chrome-extension only supports
 * `host_browser`, and the no-arg form is the gate that legacy desktop-only
 * call sites use (e.g. preactivating computer-use, restoring host proxies
 * in the drain queue). Callers that want to check a single capability —
 * for example, to decide whether to keep `hostBrowserProxy` available for
 * chrome-extension — should pass the capability explicitly:
 * `supportsHostProxy(id, "host_browser")`.
 */
export function supportsHostProxy(id: InterfaceId): id is HostProxyInterfaceId;
export function supportsHostProxy(
  id: InterfaceId,
  capability: HostProxyCapability,
): boolean;
export function supportsHostProxy(
  id: InterfaceId,
  capability?: HostProxyCapability,
): boolean {
  // host_browser is excluded for macos because the proxy path requires a
  // Chrome extension that isn't guaranteed to be attached; browser tools
  // fall back to the local Playwright Chromium instead.
  if (id === "macos") return capability !== "host_browser";
  if (id === "chrome-extension" && capability === "host_browser") return true;
  return false;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
