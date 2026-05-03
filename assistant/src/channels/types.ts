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
  "web",
  "whatsapp",
  "slack",
  "email",
  "chrome-extension",
] as const;

export type InterfaceId = (typeof INTERFACE_IDS)[number];

/**
 * Interface IDs that older clients or persisted data may still use.
 * `normalizeInterfaceId` maps these to their canonical replacements.
 */
const LEGACY_INTERFACE_ALIASES: Record<string, InterfaceId> = {
  // The web client used to report "vellum" as its interface ID. Older
  // conversation records and in-flight SSE connections may still carry this
  // value. Normalize to "web" so downstream logic only needs one branch.
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

export function parseInterfaceId(value: unknown): InterfaceId | null {
  if (typeof value !== "string") return null;
  if ((INTERFACE_IDS as readonly string[]).includes(value))
    return value as InterfaceId;
  const alias = LEGACY_INTERFACE_ALIASES[value];
  if (alias) return alias;
  return null;
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
  "web",
]);

export function isInteractiveInterface(id: InterfaceId): boolean {
  return INTERACTIVE_INTERFACES.has(id);
}

/**
 * Host proxy capabilities that an interface can support. The macOS client
 * supports all five; the chrome-extension interface only supports
 * host_browser (via the Chrome DevTools Protocol proxy).
 */
export type HostProxyCapability =
  | "host_bash"
  | "host_file"
  | "host_cu"
  | "host_browser"
  | "host_app_control";

/**
 * Interfaces that support the full desktop host-proxy set (all five
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
  // macOS supports all five host proxy capabilities including host_browser
  // and host_app_control. The host_browser proxy is provisioned via the
  // assistant event hub. When no extension is connected, browser tools fall
  // through to cdp-inspect/local via the CDP factory's candidate chain.
  if (id === "macos") return true;
  if (id === "chrome-extension" && capability === "host_browser") return true;
  return false;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
