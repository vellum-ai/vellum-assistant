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

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HostBrowserServerMessages =
  | HostBrowserRequest
  | HostBrowserCancelRequest;
