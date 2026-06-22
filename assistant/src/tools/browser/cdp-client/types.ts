/**
 * Minimal typed surface over Chrome DevTools Protocol. Implemented by
 * LocalCdpClient (Playwright-backed, same-process Chromium),
 * ExtensionCdpClient (routes through HostBrowserProxy to the user's
 * Chrome via chrome.debugger), and CdpInspectClient (connects to a
 * remote browser over a raw CDP WebSocket URL). Tools call
 * `send(method, params)` with a CDP method name and return the raw
 * CDP result object; errors are thrown as {@link CdpError}.
 */

import type { BrowserBackend } from "../../../browser-session/types.js";

/** Shape of a single Chrome tab as returned by Vellum.listTabs. */
export interface TabInfo {
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  active: boolean;
  pinned: boolean;
}

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

  /**
   * Update the `cdpSessionId` used on subsequent {@link CdpClient.send}
   * calls. Backends that don't multiplex commands across multiple
   * targets (local Playwright, cdp-inspect) may implement this as a
   * no-op. The extension backend uses this after opening a new tab
   * (via the `Vellum.createTab` pseudo-CDP method) to route
   * follow-on commands to the freshly-created tab instead of the
   * currently-active one.
   *
   * Pass `undefined` to clear an existing pinned session and revert
   * to default routing (i.e. dispatcher resolves the active tab).
   * Used in the `Vellum.createTab` no-tabId fallback path to avoid
   * sending follow-on commands to a stale/dead tab when the previous
   * pin is no longer valid.
   *
   * Optional — callers should null-check before invoking.
   */
  setCdpSessionId?(cdpSessionId: string | undefined): void;

  /**
   * List all open browser tabs. Extension backend only — returns
   * `{ tabId, windowId, url, title, active, pinned }[]`.
   * Optional — callers must null-check before invoking.
   */
  listTabs?(): Promise<TabInfo[]>;

  /**
   * Select (activate) an existing tab. Extension backend only. Optional.
   */
  selectTab?(tabId: number): Promise<{
    tabId?: number;
    windowId?: number;
    url?: string;
    title?: string;
    clientId?: string;
  }>;

  /**
   * Close a browser tab by ID. Extension backend only. Optional.
   */
  closeTab?(tabId: number): Promise<{
    closed: boolean;
    tabId: number;
    clientId?: string;
  }>;
}

/**
 * Backend kind exposed by a concrete CdpClient. Used by tools that
 * want to branch on the transport (e.g. browser_navigate should skip
 * the sacrificial-profile screencast setup when running against the
 * user's own Chrome via the extension).
 */
export type CdpClientKind = "local" | "extension" | "cdp-inspect" | "host-bridge";

/**
 * Backend mode preference for the CDP factory. Controls which
 * transport is selected:
 *
 *  - `"auto"` — default, existing priority-ordered fallback
 *    (extension → host-bridge → cdp-inspect → local).
 *  - `"extension"` — pin to the chrome-extension backend. Fails
 *    immediately if the host browser proxy is unavailable.
 *  - `"cdp-inspect"` — pin to the cdp-inspect backend. Fails
 *    immediately if cdp-inspect cannot connect.
 *  - `"local"` — pin to the local Playwright backend. No fallback.
 *
 * The `host-bridge` backend (raw CDP to the user's Chrome via the
 * desktop client's SSE bridge) is auto-mode only and not listed here —
 * see {@link InternalBrowserMode}.
 */
export type BrowserMode = "auto" | "extension" | "cdp-inspect" | "local";

/**
 * {@link BrowserMode} plus internal-only kinds the factory can pin to.
 * The conversation's sticky-backend memo records the last successful
 * {@link CdpClientKind} and re-pins to it on the next tool call; after
 * a successful host-bridge send that memo is `"host-bridge"`, which is
 * never user-requestable via `--browser-mode` but must round-trip
 * through the factory's pinned-candidate path.
 */
export type InternalBrowserMode = BrowserMode | "host-bridge";

/**
 * Stage at which a candidate attempt ended. Used in
 * {@link AttemptDiagnostic} to indicate how far the attempt progressed.
 */
export type AttemptStage =
  | "candidate_selection" // failed before construction (precondition not met)
  | "construction" // create() threw
  | "send" // manager.send() threw or returned an error envelope
  | "success"; // command completed successfully

/**
 * Structured diagnostic for a single candidate attempt during the
 * factory's failover walk. Collected into an array and attached to
 * thrown {@link CdpError} instances so higher layers can render
 * detailed failure information in user-facing tool errors.
 */
export interface AttemptDiagnostic {
  /** Which backend kind was attempted. */
  readonly candidateKind: CdpClientKind;
  /** Why this candidate was included (from {@link BackendCandidate.reason}). */
  readonly inclusionReason: string;
  /** How far the attempt progressed before it ended. */
  readonly stage: AttemptStage;
  /** Error code from the CdpError, if the attempt failed. */
  readonly errorCode?: string;
  /** Error message from the CdpError, if the attempt failed. */
  readonly errorMessage?: string;
  /** Discovery-level error code extracted from the underlying error, if any. */
  readonly discoveryCode?: string;
}

/**
 * Concrete CdpClient instance returned by the factory. Carries the
 * backend `kind` for transport-aware branches in tool code.
 */
export interface ScopedCdpClient extends CdpClient {
  readonly kind: CdpClientKind;
  /** Stable conversation id this client is bound to. */
  readonly conversationId: string;
  /**
   * Re-target follow-on CDP commands at a specific tab/target. Calling
   * this updates the underlying client's `cdpSessionId`. This is used by
   * the navigator executor after `Vellum.createTab` returns to ensure the
   * subsequent `Page.navigate` and all follow-on commands on this
   * conversation route to the newly-created tab instead of the
   * previously-active tab.
   *
   * Pass `undefined` to clear an existing pinned session on the chained
   * client and on the underlying client (if it supports the method).
   * Used in the `Vellum.createTab` no-tabId fallback path.
   *
   * If the underlying client doesn't implement this method (e.g., local
   * or cdp-inspect clients), the call is silently ignored via optional
   * chaining.
   */
  setCdpSessionId(cdpSessionId: string | undefined): void;

  /**
   * List all open browser tabs. Throws with code "transport_error" if
   * the current backend does not support tab listing.
   */
  listTabs(): Promise<TabInfo[]>;

  /**
   * Select (activate) an existing tab. Throws if backend doesn't support it.
   */
  selectTab(tabId: number): Promise<{
    tabId?: number;
    windowId?: number;
    url?: string;
    title?: string;
    clientId?: string;
  }>;

  /**
   * Close a browser tab by ID. Throws if backend doesn't support it.
   * The optional `clientId` identifies which extension client actually
   * closed the tab — used to scope pin cleanup in multi-client setups.
   */
  closeTab(tabId: number): Promise<{
    closed: boolean;
    tabId: number;
    clientId?: string;
  }>;
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
   * Actor the candidate was built for. Set on host-bridge candidates so
   * a transport failure records the cooldown for the owning actor only
   * (the bridge reaches a different desktop machine per actor).
   */
  readonly sourceActorPrincipalId?: string;
  /**
   * Materialise the backend. Called at most once — the factory caches
   * the result after the first successful CDP command so subsequent
   * commands reuse the same backend (sticky semantics).
   */
  create(): {
    client: CdpClient;
    backend: BrowserBackend;
  };
}
