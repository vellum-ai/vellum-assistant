/**
 * Mock Chrome extension test fixture.
 *
 * Subscribes to the runtime's `/events` SSE endpoint (registering in the
 * client registry with `interfaceId: "chrome-extension"`), handles incoming
 * `host_browser_request` events by calling a mock CDP proxy, and POSTs
 * the result back to `/v1/host-browser-result`.
 *
 * Optionally opens a WebSocket to `/v1/browser-relay` for sending inbound
 * frames (events, session-invalidation, keepalive) and for the WS result
 * transport variant.
 *
 * Used by e2e tests to exercise the full round-trip without requiring a
 * real Chrome browser or the real extension worker.
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
   */
  resultTransport?: "http" | "ws";
  /**
   * Separate JWT for SSE `/events` auth. When the primary `token` is a
   * capability token (not a JWT), provide a real JWT here so the SSE
   * endpoint accepts the connection.
   */
  sseToken?: string;
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
  const clientId = `mock-ext-${crypto.randomUUID()}`;

  let ws: WebSocket | null = null;
  let wsConnected = false;
  let sseAbort: AbortController | null = null;
  let sseConnected = false;
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
    if (abortCtl.signal.aborted) return;

    const body: HostBrowserResultBody = {
      requestId: frame.requestId,
      content: result.content,
      isError: result.isError,
    };
    if (resultTransport === "ws") {
      const sock = ws;
      if (sock && sock.readyState === WebSocket.OPEN) {
        try {
          sock.send(JSON.stringify({ type: "host_browser_result", ...body }));
        } catch {
          // best-effort
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
          // Same-actor binding: identifies this fixture to the daemon's
          // result-route check. The daemon will reject targeted host_browser
          // results without this header (or where it doesn't match the
          // captured target client).
          "X-Vellum-Client-Id": clientId,
        },
        body: JSON.stringify(body),
      });
      await res.body?.cancel();
    } catch {
      // best-effort
    }
  }

  /** Handle an incoming message (from SSE event or WS frame). */
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
  }

  /** Start SSE connection to /events — registers in client registry and
   *  receives outbound host_browser events from the event hub. */
  async function startSse(): Promise<void> {
    sseAbort = new AbortController();
    const sseUrl = `${baseHttp}/v1/events`;
    const res = await fetch(sseUrl, {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${options.sseToken ?? options.token}`,
        "X-Vellum-Client-Id": clientId,
        "X-Vellum-Interface-Id": "chrome-extension",
      },
      signal: sseAbort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }
    sseConnected = true;

    // Read SSE stream in the background
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Parse SSE frames: "data: ...\n\n"
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const lines = part.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                // SSE data is JSON-encoded AssistantEvent; extract
                // the message field
                try {
                  const event = JSON.parse(data) as {
                    message?: unknown;
                  };
                  if (event.message) {
                    handleMessage(JSON.stringify(event.message));
                  }
                } catch {
                  // skip malformed SSE data
                }
              }
            }
          }
        }
      } catch {
        // SSE stream ended (abort or server shutdown)
      } finally {
        sseConnected = false;
      }
    })();
  }

  /** Start the optional WS connection for sending inbound frames. */
  async function startWs(): Promise<void> {
    const wsOptions: { headers?: Record<string, string> } = {};
    if (options.extraHandshakeHeaders) {
      wsOptions.headers = options.extraHandshakeHeaders;
    }
    ws = new WebSocket(wsUrl, wsOptions as unknown as string | string[]);
    ws.addEventListener("open", () => {
      wsConnected = true;
    });
    ws.addEventListener("close", () => {
      wsConnected = false;
    });
  }

  return {
    async start() {
      await startSse();
      await startWs();
    },
    async stop() {
      sseAbort?.abort();
      sseAbort = null;
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
      while (!sseConnected || !wsConnected) {
        if (Date.now() > deadline) {
          throw new Error(
            `mock-chrome-extension: timed out waiting for connection (SSE=${sseConnected}, WS=${wsConnected}) after ${timeoutMs}ms`,
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
      sseAbort?.abort();
      sseAbort = null;
      sseConnected = false;
      const sock = ws;
      ws = null;
      wsConnected = false;
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
