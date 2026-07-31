import {
  CHANNEL_IDS,
  type ChannelId,
  INTERFACE_IDS,
  type InterfaceId,
  isChannelId,
  isInterfaceId,
  parseInterfaceId,
} from "@vellumai/service-contracts/channels";

// The assistant understands the full canonical channel and interface sets, so
// it adopts the shared vocabularies wholesale. `parseChannelId` stays local
// because it is a thin convenience over the shared guard.
export {
  CHANNEL_IDS,
  type ChannelId,
  INTERFACE_IDS,
  type InterfaceId,
  isChannelId,
  isInterfaceId,
  parseInterfaceId,
};

export function parseChannelId(value: unknown): ChannelId | null {
  return isChannelId(value) ? value : null;
}

export interface TurnChannelContext {
  userMessageChannel: ChannelId;
  assistantMessageChannel: ChannelId;
}

/**
 * Display metadata for a channel, returned alongside the channel id from
 * `/v1/channels/available`. Owning this in the gateway (rather than letting
 * each client carry its own icon/label/copy switch) keeps the Contacts /
 * Channels UI consistent across macOS, web, and any future surface, and
 * lets us add or rename a channel without shipping new client builds.
 */
export interface ChannelInfo {
  id: ChannelId;
  /** Title shown on the channel card, e.g. "Slack". */
  label: string;
  /** One-line description shown under the title. */
  subtitle: string;
  /**
   * Lucide icon name without the `lucide-` prefix, e.g. `"mail"` or
   * `"hash"`. macOS clients resolve to `VIcon(rawValue: "lucide-\(icon)")`;
   * web clients import the matching component from `lucide-react`.
   */
  icon: string;
  /**
   * Whether this channel has a client-side verification flow (the
   * `ChannelVerificationFlowView` on macOS, equivalent on web). When
   * `false`, clients skip pre-warming verification status and render the
   * card in display-only mode.
   */
  supportsVerification: boolean;
  /** Suggested first-turn user messages that open the conversation that drives setup. */
  setupMessages: {
    guardian: string;
    contact: string;
  };
}

/**
 * Per-channel display metadata for the channels the gateway can currently
 * surface to clients. Add an entry here when surfacing a new channel via
 * `/v1/channels/available`. `Partial` because unsurfaced channels (e.g.
 * `vellum`, `platform`) deliberately have no metadata — keep this map
 * minimal until there's a real surface to feed.
 */
export const CHANNEL_METADATA: Partial<Record<ChannelId, ChannelInfo>> = {
  slack: {
    id: "slack",
    label: "Slack",
    subtitle: "Message your assistant from Slack",
    icon: "hash",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian on Slack. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's Slack identity. Can you walk me through it?",
    },
  },
  telegram: {
    id: "telegram",
    label: "Telegram",
    subtitle: "Message your assistant from Telegram",
    icon: "send",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian on Telegram. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's Telegram identity. Can you walk me through it?",
    },
  },
  phone: {
    id: "phone",
    label: "Phone Calling",
    subtitle: "Call or text your assistant via phone",
    icon: "phone",
    supportsVerification: true,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian for phone calls. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's phone number. Can you help me set that up?",
    },
  },
  email: {
    id: "email",
    label: "Email",
    subtitle: "Reach your assistant by email",
    icon: "mail",
    supportsVerification: false,
    setupMessages: {
      guardian:
        "I'd like to set up email as a way for me to reach you. Can you walk me through it?",
      contact:
        "I'd like to set up email as a way to reach this contact. Can you walk me through it?",
    },
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp",
    subtitle: "Message your assistant on WhatsApp",
    icon: "message-square",
    supportsVerification: false,
    setupMessages: {
      guardian:
        "I'd like to verify my identity as your guardian on WhatsApp. Can you help me set that up?",
      contact:
        "I'd like to verify a contact's WhatsApp identity. Can you walk me through it?",
    },
  },
  a2a: {
    id: "a2a",
    label: "A2A",
    subtitle: "Agent-to-Agent protocol",
    icon: "bot",
    supportsVerification: false,
    setupMessages: {
      guardian: "Connect with other Vellum assistants via the A2A protocol.",
      contact:
        "I'd like to connect with another assistant via A2A. Can you help me set that up?",
    },
  },
};

/**
 * Client OS surfaces — the value set for the message-body `clientOs` field.
 *
 * This is deliberately SEPARATE from {@link INTERFACE_IDS}: `clientOs`
 * describes which OS the user's device runs, not which transport the turn
 * arrived on. `"android"` (and `"ios"` for a mobile browser) are real OS
 * surfaces but not transports — they must never answer transport questions
 * (`supportsHostProxy`, `isInteractiveInterface`), so they live here rather
 * than polluting the interface vocabulary. Drives only the per-turn
 * `client_os` context line (e.g. app-builder mobile-first for `ios`/`android`).
 */
export const CLIENT_OS_VALUES = ["web", "ios", "macos", "android"] as const;

export type ClientOs = (typeof CLIENT_OS_VALUES)[number];

/** Parse/validate a reported `clientOs`. Returns `null` for unknown values. */
export function parseClientOs(value: unknown): ClientOs | null {
  if (typeof value !== "string") {
    return null;
  }
  return (CLIENT_OS_VALUES as readonly string[]).includes(value)
    ? (value as ClientOs)
    : null;
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
 * supports all of them; the chrome-extension interface only supports
 * host_browser (via the Chrome DevTools Protocol proxy).
 */
export const HOST_PROXY_CAPABILITIES = [
  "host_bash",
  "host_file",
  "host_cu",
  "host_browser",
  "host_app_control",
  "host_ui_snapshot",
] as const;

export type HostProxyCapability = (typeof HOST_PROXY_CAPABILITIES)[number];

/**
 * Interfaces that support the full desktop host-proxy set (every
 * `HostProxyCapability` value). This is the capability-level identity used
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
  // macOS supports every host proxy capability including host_browser
  // and host_app_control. The host_browser proxy is provisioned via the
  // assistant event hub. When no extension is connected, browser tools fall
  // through to cdp-inspect/local via the CDP factory's candidate chain.
  if (id === "macos") {
    return true;
  }
  if (id === "chrome-extension" && capability === "host_browser") {
    return true;
  }
  return false;
}

export interface TurnInterfaceContext {
  userMessageInterface: InterfaceId;
  assistantMessageInterface: InterfaceId;
}
