/**
 * Minimal typed surface over Chrome DevTools Protocol. Implemented by
 * LocalCdpClient (Playwright-backed, same-process Chromium),
 * ExtensionCdpClient (routes through HostBrowserProxy to the user's
 * Chrome via chrome.debugger), and CdpInspectClient (connects to a
 * remote browser over a raw CDP WebSocket URL). Tools call
 * `send(method, params)` with a CDP method name and return the raw
 * CDP result object; errors are thrown as {@link CdpError}.
 */
export interface CdpClient {
  /**
   * Send a CDP command and await the result. `method` must be a
   * well-known CDP method name (e.g. "Page.navigate",
   * "Runtime.evaluate", "Accessibility.getFullAXTree"). `params` is
   * forwarded verbatim.
   *
   * On success, returns the raw `result` object from the CDP response
   * as `T`. On JSON-RPC error or transport failure, throws a
   * {@link CdpError}. Abort propagates via `signal`; aborted calls
   * throw an {@link CdpError} with `code === "aborted"`.
   */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;

  /**
   * Release any backend-side resources (CDP sessions, in-flight
   * requests, listeners). Idempotent. Calling `send` after `dispose`
   * is allowed but should surface as an error.
   */
  dispose(): void;
}

/**
 * Backend kind exposed by a concrete CdpClient. Used by tools that
 * want to branch on the transport (e.g. browser_navigate should skip
 * the sacrificial-profile screencast setup when running against the
 * user's own Chrome via the extension).
 */
export type CdpClientKind = "local" | "extension" | "cdp-inspect";

/**
 * Concrete CdpClient instance returned by the factory. Carries the
 * backend `kind` for transport-aware branches in tool code.
 */
export interface ScopedCdpClient extends CdpClient {
  readonly kind: CdpClientKind;
  /** Stable conversation id this client is bound to. */
  readonly conversationId: string;
}

/**
 * A deferred backend candidate used by the chained factory. Each
 * candidate carries a `kind` label and a `create` thunk that
 * materialises the underlying {@link CdpClient} + {@link BrowserBackend}
 * on demand. The factory only calls `create()` when the candidate is
 * actually selected (either as the primary or as a failover target),
 * so backends that are never reached pay zero setup cost.
 */
export interface BackendCandidate {
  readonly kind: CdpClientKind;
  /** Human-readable reason this candidate was included. */
  readonly reason: string;
  /**
   * Materialise the backend. Called at most once — the factory caches
   * the result after the first successful CDP command so subsequent
   * commands reuse the same backend (sticky semantics).
   */
  create(): {
    client: CdpClient;
    backend: import("../../../browser-session/types.js").BrowserBackend;
  };
}
