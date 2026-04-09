// Host browser proxy types.
// Enables proxying CDP commands to the desktop client (host machine)
// when running as a managed assistant.

// === Server → Client ===

export interface HostBrowserRequest {
  type: "host_browser_request";
  requestId: string;
  conversationId: string;
  /** CDP method name, e.g. "Page.navigate", "Runtime.evaluate", "Accessibility.getFullAXTree". */
  cdpMethod: string;
  /** Opaque JSON params object forwarded verbatim to CDP. */
  cdpParams?: Record<string, unknown>;
  /** Optional CDP target/session ID; omitted = "most-recently-active tab". */
  cdpSessionId?: string;
  /** Client-side timeout hint; defaults to 30s in the proxy. */
  timeout_seconds?: number;
}

export interface HostBrowserCancelRequest {
  type: "host_browser_cancel";
  requestId: string;
}

// === Client → Server ===

/**
 * Unsolicited CDP event forwarded from the chrome extension to the
 * runtime. The extension subscribes to `chrome.debugger.onEvent` and
 * pushes each event here so the runtime can observe lifecycle signals
 * (e.g. `Target.targetDestroyed`, `Page.frameNavigated`,
 * `Network.requestWillBeSent`) without having to round-trip a CDP
 * command. Events are routed through the relay WebSocket using the
 * same envelope vocabulary as `host_browser_result`.
 *
 * The envelope is transport-level only — the runtime dispatcher in
 * `resolveHostBrowserEvent` fans out into a module-level event bus
 * that tool-side consumers (currently just the
 * BrowserSessionRegistry) subscribe to by method name. No request/
 * response contract is implied; events can arrive at any time while
 * a chrome extension is attached and there is no ordering guarantee
 * relative to `host_browser_result` frames.
 */
export interface HostBrowserEvent {
  type: "host_browser_event";
  /** CDP event method name, e.g. "Page.frameNavigated", "Target.targetDestroyed". */
  method: string;
  /** CDP event params forwarded verbatim. Opaque to the runtime. */
  params?: unknown;
  /**
   * Optional CDP session id — populated for flat child sessions
   * routed through `Target.attachToTarget` with `flatten: true`.
   * Matches the `source.sessionId` field surfaced by Chrome 125+ in
   * its `chrome.debugger.onEvent` callback.
   */
  cdpSessionId?: string;
}

/**
 * Notification that the chrome extension has lost its debugger
 * attachment to a target (tab closed, user clicked Cancel on the
 * infobar, navigation across origins, another debugger took over
 * via `Target.attachToTarget`, or the extension itself tore the
 * session down on worker shutdown).
 *
 * The runtime dispatcher evicts any in-memory session state that
 * references the invalidated target so the next CDP command from a
 * tool force a fresh attach on the extension side. The extension's
 * `host-browser-dispatcher` clears its local attach cache in the
 * same way — the two signals are symmetric and together make
 * reattach deterministic across the round-trip.
 */
export interface HostBrowserSessionInvalidated {
  type: "host_browser_session_invalidated";
  /**
   * Opaque target identifier. When the extension detached from a
   * top-level tab target, this is the tab's id as a string. For a
   * flat child session it is the CDP sessionId. Matches the shape
   * used on the `cdpSessionId` field of outbound
   * `host_browser_request` frames so runtime-side session lookups
   * can use either field interchangeably.
   */
  targetId?: string;
  /**
   * Free-form human-readable reason surfaced by Chrome via
   * `chrome.debugger.onDetach`. Used only for logging.
   */
  reason?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostBrowserServerMessages =
  | HostBrowserRequest
  | HostBrowserCancelRequest;

export type _HostBrowserClientMessages =
  | HostBrowserEvent
  | HostBrowserSessionInvalidated;
