// Conversation lifecycle, model config, and transport metadata types.
//
// Server→client events are single-sourced from their canonical `api/events`
// wire schemas; this file composes them into the domain union consumed by
// `message-protocol.ts` and defines the transport-metadata shapes the create /
// messaging path uses. Conversation management (create, list, switch, rename,
// history, undo, usage, clear, reorder) is served by the HTTP conversation
// routes, not by client messages.

import type {
  ChannelId,
  HostProxyInterfaceId,
  InterfaceId,
} from "../../channels/types.js";
import { supportsHostProxy } from "../../channels/types.js";

// === Transport metadata ===

/** Shared fields for all transport metadata variants. */
interface BaseTransportMetadata {
  /** Logical channel identifier (e.g. "desktop", "telegram", "mobile"). */
  channelId: ChannelId;
  /** Optional natural-language hints for channel-specific UX behavior. */
  hints?: string[];
  /** Optional concise UX brief for this channel. */
  uxBrief?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup", "channel"). */
  chatType?: string;
  /** IANA timezone reported by the active client for the current turn. */
  clientTimezone?: string;
  /**
   * The client's operating-system surface, reported independently of
   * {@link interfaceId}. The web bundle ships to browsers, mobile shells, and
   * Electron desktop apps on the same `"web"` transport interface. `clientOs`
   * tells the assistant which OS it is actually talking to, rendered as the
   * `client_os:` line in the per-turn context, without perturbing
   * transport/host-proxy capability inference, which keys off `interfaceId`.
   */
  clientOs?: string;
  /**
   * Id of the app the client currently has open on screen (the app viewer or
   * the app-editing split). Rendered as the `visible_app:` line in the per-turn
   * context so the assistant knows which app "the app" refers to without the
   * user naming it. View state only: it never affects transport or tool
   * gating, and is absent whenever no app is in view.
   */
  visibleAppId?: string;
}

/**
 * Transport metadata for interfaces that support the full desktop host-proxy
 * set (see `HostProxyInterfaceId` / `supportsHostProxy`). Carries the host
 * environment fields the client reports so the `<workspace>` block renders
 * the user's actual machine rather than a containerized daemon's own OS.
 *
 * Today this variant is populated only by the macOS client, but the shape
 * is capability-keyed (not interface-name-keyed) so future host-capable
 * clients (e.g. a native Linux or Windows desktop) get the same treatment
 * automatically when added to `HostProxyInterfaceId`.
 */
export interface HostProxyTransportMetadata extends BaseTransportMetadata {
  /** Interface identifier — restricted to interfaces that support host proxies. */
  interfaceId: HostProxyInterfaceId;
  /** Home directory of the user on the host machine (e.g. `NSHomeDirectory()`). */
  hostHomeDir?: string;
  /** Username of the user on the host machine (e.g. `NSUserName()`). */
  hostUsername?: string;
}

/**
 * Transport metadata for interfaces that do NOT support host-proxy tools
 * (iOS, CLI, channel ingress, chrome-extension, etc.). No host environment
 * because the assistant has no local filesystem to address on the client.
 */
export interface NonHostProxyTransportMetadata extends BaseTransportMetadata {
  /** Interface identifier for this transport (e.g. "ios", "cli"). */
  interfaceId?: Exclude<InterfaceId, HostProxyInterfaceId>;
}

/**
 * Discriminated union of transport metadata variants, keyed on whether the
 * interface supports host-proxy tools (`supportsHostProxy`). The daemon uses
 * that same predicate at runtime to decide whether to populate / read host
 * environment fields on the conversation, so the type system and the runtime
 * gate stay in lock-step as new host-capable interfaces are added.
 */
export type ConversationTransportMetadata =
  | HostProxyTransportMetadata
  | NonHostProxyTransportMetadata;

/**
 * Type guard: does this transport belong to an interface that supports the
 * full host-proxy set? Wraps `supportsHostProxy` so the capability logic
 * stays in one place (channels/types.ts) and narrows the discriminated
 * union to `HostProxyTransportMetadata` for safe field access.
 */
export function isHostProxyTransport(
  transport: ConversationTransportMetadata,
): transport is HostProxyTransportMetadata {
  return (
    transport.interfaceId !== undefined &&
    supportsHostProxy(transport.interfaceId)
  );
}

// === Server → Client ===

// `open_conversation` is a migrated event: its canonical wire contract lives
// in `../../api/events/open-conversation.ts` (imported as
// `OpenConversationEvent`). Instructs the client to open and, by default,
// focus a conversation — see that file for the full field docs.
