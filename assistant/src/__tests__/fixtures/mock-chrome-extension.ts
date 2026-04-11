/**
 * Mock Chrome extension test fixture.
 *
 * Opens a WebSocket to the runtime's `/v1/browser-relay` endpoint using a
 * caller-supplied JWT (so the upgrade handler registers the connection
 * under the guardianId encoded in the token), handles incoming
 * `host_browser_request` frames by calling a mock CDP proxy, and POSTs
 * the result back to `/v1/host-browser-result`.
 *
 * Used by e2e tests (PR 15/16) to exercise the full round-trip without
 * requiring a real Chrome browser or the real extension worker.
 *
 * The fixture is intentionally minimal — it does not implement heartbeats
 * or reconnect logic. It only needs to carry host_browser_request frames
 * end-to-end.
 */

// ── Types ───────────────────────────────────────────────────────────

/** Incoming `host_browser_request` envelope (wire format). */
export interface HostBrowserRequestFrame {
  type: "host_browser_request";
  requestId: string;
  conversationId: string;
  cdpMethod: string;
  cdpParams?: Record<string, unknown>;
  cdpSessionId?: string;
  timeout_seconds?: number;
}

/** Incoming `host_browser_cancel` envelope (wire format). */
export interface HostBrowserCancelFrame {
  type: "host_browser_cancel";
  requestId: string;
}

/** Result body POSTed back to `/v1/host-browser-result`. */
export interface HostBrowserResultBody {
  requestId: string;
  content: string;
  isError: boolean;
}

/**
 * Callback that handles a CDP request and returns a
 * (content, isError) pair to be POSTed back to the runtime.
 *
 * Tests pass in a mock that simulates `chrome.debugger.sendCommand` for a
 * handful of methods (e.g. `Browser.getVersion`).
 */
export type MockCdpHandler = (
  frame: HostBrowserRequestFrame,
) => Promise<{ content: string; isError: boolean }>;

export interface MockChromeExtensionOptions {
  /** Base URL of the runtime HTTP server, e.g. `http://127.0.0.1:19801`. */
  runtimeBaseUrl: string;
  /** JWT bearer token for both the WebSocket handshake and the POST callback. */
  token: string;
  /**
   * CDP command handler. Defaults to a handler that recognises
   * `Browser.getVersion` and returns a fake product string.
   */
  cdpHandler?: MockCdpHandler;
  /**
   * Optional extra headers forwarded on the WebSocket handshake (e.g.
   * `x-guardian-id` when using a service token that doesn't carry an
   * actor principal id).
   */
  extraHandshakeHeaders?: Record<string, string>;
  /**
   * Transport used to submit the result back to the runtime.
   *   - "http" (default): POST to `/v1/host-browser-result`.
   *   - "ws": send a `host_browser_result` frame back over the same
   *     `/v1/browser-relay` WebSocket that delivered the request.
   *
   * Both transports are expected to be fully functional in the runtime.
   * The HTTP path is the legacy transport; the WS path was added so the
   * extension can avoid an extra round-trip through the cloud ingress
   * stack for each CDP command.
   */
  resultTransport?: "http" | "ws";
}

export interface MockChromeExtension {
  /** Open the WebSocket and resolve once it's connected. */
  start(): Promise<void>;
  /** Close the WebSocket and drop any in-flight request tracking. */
  stop(): Promise<void>;
  /**
   * Wait until the WebSocket has transitioned to OPEN. Useful to avoid
   * races between `start()` and the runtime's `register()` bookkeeping.
   */
  waitForConnection(timeoutMs?: number): Promise<void>;
  /** List of every `host_browser_request` frame received, in order. */
  receivedRequests(): ReadonlyArray<HostBrowserRequestFrame>;
  /** List of every `host_browser_cancel` frame received, in order. */
  receivedCancels(): ReadonlyArray<HostBrowserCancelFrame>;
  /** Swap the CDP handler at runtime (tests can inject failure modes). */
  setCdpHandler(handler: MockCdpHandler): void;
  /**
   * Force-close the WebSocket without going through the teardown path.
   * Simulates a flaky extension that drops the connection.
   */
  forceDisconnect(): void;
  /**
   * Send a `host_browser_event` frame over the active WebSocket,
   * mirroring what the extension's host-browser-dispatcher does in
   * response to `chrome.debugger.onEvent`. Used by PR10 acceptance
   * tests to assert that the runtime's WS handler fans CDP events
   * out through the browser-session event bus.
   */
  sendHostBrowserEvent(event: {
    method: string;
    params?: unknown;
    cdpSessionId?: string;
  }): void;
  /**
   * Send a `host_browser_session_invalidated` frame over the active
   * WebSocket, mirroring what the extension's host-browser-dispatcher
   * does in response to `chrome.debugger.onDetach`. Used by PR10
   * acceptance tests to assert that the runtime-side session
   * registry evicts stale sessions and forces reattach on the next
   * command.
   */
  sendSessionInvalidated(event: { targetId?: string; reason?: string }): void;
  /**
   * Send an arbitrary pre-serialized JSON string over the active
   * WebSocket. Used by tests that need to send frame types not covered
   * by the fixture's typed helpers (e.g. keepalive frames).
   */
  sendRaw(json: string): void;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_MOCK_BROWSER_VERSION = {
  product: "Chrome/MockTest",
  protocolVersion: "1.3",
  revision: "@mock",
  userAgent: "Mozilla/5.0 (mock chrome-extension e2e fixture)",
  jsVersion: "0.0.0-mock",
};

/**
 * Default CDP handler: answers `Browser.getVersion` with a fake product
 * string. Unrecognised methods return an error envelope so tests can fail
 * fast instead of hanging.
 */
const defaultCdpHandler: MockCdpHandler = async (frame) => {
  if (frame.cdpMethod === "Browser.getVersion") {
    return {
      content: JSON.stringify(DEFAULT_MOCK_BROWSER_VERSION),
      isError: false,
    };
  }
  return {
    content: `mock-chrome-extension: unsupported cdpMethod "${frame.cdpMethod}"`,
    isError: true,
  };
};

// ── Implementation ──────────────────────────────────────────────────

/**
 * Create a mock chrome-extension client bound to the given runtime base
 * URL. The fixture does not start itself; callers must invoke `start()`.
 */
export function createMockChromeExtension(
  options: MockChromeExtensionOptions,
): MockChromeExtension {
  const baseHttp = options.runtimeBaseUrl.replace(/\/$/, "");
  const wsBase = baseHttp.replace(/^http/i, "ws");
  const wsUrl = `${wsBase}/v1/browser-relay?token=${encodeURIComponent(options.token)}`;

  let ws: WebSocket | null = null;
  let connected = false;
  let handler = options.cdpHandler ?? defaultCdpHandler;
  const receivedRequests: HostBrowserRequestFrame[] = [];
  const receivedCancels: HostBrowserCancelFrame[] = [];
  const inFlight = new Map<string, AbortController>();
  const resultTransport = options.resultTransport ?? "http";

  async function handleRequestFrame(
    frame: HostBrowserRequestFrame,
  ): Promise<void> {
    const abortCtl = new AbortController();
    inFlight.set(frame.requestId, abortCtl);
    let result: { content: string; isError: boolean };
    try {
      result = await handler(frame);
    } catch (err) {
      result = {
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    } finally {
      inFlight.delete(frame.requestId);
    }
    // If the request was aborted mid-flight, drop the result entirely
    // (mirroring the production dispatcher, which doesn't POST a result
    // for cancelled requests).
    if (abortCtl.signal.aborted) return;

    const body: HostBrowserResultBody = {
      requestId: frame.requestId,
      content: result.content,
      isError: result.isError,
    };
    if (resultTransport === "ws") {
      // Send the result back over the same `/v1/browser-relay` socket
      // that delivered the request. The runtime WS message handler
      // parses `host_browser_result` frames and resolves the pending
      // interaction via the same core resolver the HTTP endpoint uses.
      const sock = ws;
      if (sock && sock.readyState === WebSocket.OPEN) {
        try {
          sock.send(
            JSON.stringify({
              type: "host_browser_result",
              ...body,
            }),
          );
        } catch {
          // Best-effort — mirrors the HTTP POST failure mode.
        }
      }
      return;
    }
    try {
      const res = await fetch(`${baseHttp}/v1/host-browser-result`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(body),
      });
      // Consume the body so Bun doesn't leak the response handle.
      await res.body?.cancel();
    } catch {
      // Best-effort — if the runtime has torn down the server, the POST
      // will throw. Tests assert on proxy behaviour, not POST success.
    }
  }

  function handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const frame = parsed as Record<string, unknown>;
    if (frame.type === "host_browser_request") {
      const typed = frame as unknown as HostBrowserRequestFrame;
      receivedRequests.push(typed);
      void handleRequestFrame(typed);
      return;
    }
    if (frame.type === "host_browser_cancel") {
      const typed = frame as unknown as HostBrowserCancelFrame;
      receivedCancels.push(typed);
      const abort = inFlight.get(typed.requestId);
      if (abort) {
        abort.abort();
        inFlight.delete(typed.requestId);
      }
      return;
    }
    // Ignore any other frames.
  }

  return {
    async start() {
      if (ws) return;
      // Bun's `WebSocket` constructor accepts a second-argument options
      // object with a `headers` field (a Bun-specific extension of the
      // standard WebSocket API). We forward `extraHandshakeHeaders`
      // through it so tests using service tokens can supply the
      // `x-guardian-id` fallback expected by `/v1/browser-relay`.
      //
      // We cast through `unknown` because the DOM `WebSocket` type only
      // knows about `(url, protocols)`. If this fixture is ever run in
      // an environment that isn't Bun, the options object would be
      // silently ignored — acceptable for a test fixture.
      const wsOptions: { headers?: Record<string, string> } = {};
      if (options.extraHandshakeHeaders) {
        wsOptions.headers = options.extraHandshakeHeaders;
      }
      ws = new WebSocket(wsUrl, wsOptions as unknown as string | string[]);
      ws.addEventListener("open", () => {
        connected = true;
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        const data = ev.data;
        if (typeof data === "string") {
          handleMessage(data);
        } else if (data instanceof ArrayBuffer) {
          handleMessage(new TextDecoder().decode(data));
        }
      });
      ws.addEventListener("close", () => {
        connected = false;
      });
    },
    async stop() {
      const sock = ws;
      ws = null;
      if (sock) {
        try {
          sock.close(1000, "fixture shutdown");
        } catch {
          // best-effort
        }
      }
      for (const abort of inFlight.values()) {
        abort.abort();
      }
      inFlight.clear();
    },
    async waitForConnection(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (!connected) {
        if (Date.now() > deadline) {
          throw new Error(
            `mock-chrome-extension: timed out waiting for WebSocket OPEN after ${timeoutMs}ms`,
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    receivedRequests() {
      return receivedRequests;
    },
    receivedCancels() {
      return receivedCancels;
    },
    setCdpHandler(next) {
      handler = next;
    },
    forceDisconnect() {
      const sock = ws;
      ws = null;
      connected = false;
      if (sock) {
        try {
          sock.close(4000, "forced disconnect");
        } catch {
          // best-effort
        }
      }
    },
    sendHostBrowserEvent(event) {
      const sock = ws;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(
        JSON.stringify({
          type: "host_browser_event",
          method: event.method,
          ...(event.params !== undefined ? { params: event.params } : {}),
          ...(event.cdpSessionId !== undefined
            ? { cdpSessionId: event.cdpSessionId }
            : {}),
        }),
      );
    },
    sendSessionInvalidated(event) {
      const sock = ws;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(
        JSON.stringify({
          type: "host_browser_session_invalidated",
          ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        }),
      );
    },
    sendRaw(json: string) {
      const sock = ws;
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      sock.send(json);
    },
  };
}
