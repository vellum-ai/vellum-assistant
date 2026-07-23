// Host browser proxy types.
//
// The server→client CDP proxy events (`host_browser_request` /
// `host_browser_cancel`) are single-sourced from their canonical `api/events`
// wire schema. The client→server events below are unsolicited signals the
// chrome extension pushes back to the runtime.

import type { HostBrowserCancelEvent } from "../../api/events/host-browser.js";
import type { HostBrowserRequestEvent } from "../../api/events/host-browser.js";

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
  | HostBrowserRequestEvent
  | HostBrowserCancelEvent;

export type _HostBrowserClientMessages =
  | HostBrowserEvent
  | HostBrowserSessionInvalidated;
