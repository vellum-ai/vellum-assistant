import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Stubs — must precede the executor import
// ---------------------------------------------------------------------------

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";
mock.module("../device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
  resetDeviceIdCache: () => {},
}));

mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock fetch at the global level
// ---------------------------------------------------------------------------

let mockFetchImpl: typeof globalThis.fetch = (async () => new Response("[]")) as unknown as typeof globalThis.fetch;

// We need to intercept fetch calls for target discovery
globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
  return mockFetchImpl(...args);
}) as unknown as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(url: string) {
    this.url = url;
    // Simulate async connection
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open");
      }
    }, 5);
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void, opts?: { once?: boolean }) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    if (opts?.once) {
      const wrapped = (...args: unknown[]) => {
        this.listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      this.listeners.get(event)!.add(wrapped);
    } else {
      this.listeners.get(event)!.add(listener);
    }
  }

  removeEventListener(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, data?: unknown) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      handler(data);
    }
  }

  send = mock((_data: string) => {});
  close = mock(() => {
    this.readyState = MockWebSocket.CLOSED;
  });
}

// Store created WebSocket instances for test manipulation
let createdWebSockets: MockWebSocket[] = [];

globalThis.WebSocket = class extends MockWebSocket {
  constructor(url: string) {
    super(url);
    createdWebSockets.push(this);
  }
} as unknown as typeof WebSocket;

// Static constants on the class
Object.assign(globalThis.WebSocket, {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
});

const { HostBrowserExecutor, __testing } = await import("./host-browser-executor");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Build a page target entry as returned by /json/list. */
function pageTarget(
  id: string,
  wsUrl = `ws://localhost:9222/devtools/page/${id}`,
): Record<string, unknown> {
  return {
    id,
    type: "page",
    title: `Page ${id}`,
    url: `http://example.com/${id}`,
    webSocketDebuggerUrl: wsUrl,
  };
}

/** Create a capturing poster that records all postBrowserResult calls. */
function capturingPoster() {
  const results: Array<{ requestId: string; content?: string; isError?: boolean }> = [];
  return {
    results,
    poster: {
      postBrowserResult: async (payload: { requestId: string; content?: string; isError?: boolean }) => {
        results.push(payload);
        return true;
      },
    } as unknown as import("../host-proxy-poster").HostProxyPoster,
  };
}

/** Set fetch to return the given target list for /json/list. */
function setTargets(targets: Record<string, unknown>[]) {
  mockFetchImpl = (async () => new Response(JSON.stringify(targets), { status: 200 })) as unknown as typeof globalThis.fetch;
}

/** Set fetch to fail. */
function setFetchError(msg = "Connection refused") {
  mockFetchImpl = (async () => { throw new Error(msg); }) as unknown as typeof globalThis.fetch;
}

/**
 * After flush, find the most recently created mock WebSocket and simulate
 * a CDP response.
 */
function replyToCDP(
  ws: MockWebSocket,
  commandId: number,
  result: unknown,
) {
  ws.emit("message", { data: JSON.stringify({ id: commandId, result }) });
}

function replyWithCDPError(
  ws: MockWebSocket,
  commandId: number,
  code: number,
  message: string,
) {
  ws.emit("message", { data: JSON.stringify({ id: commandId, error: { code, message } }) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HostBrowserExecutor", () => {
  let executor: InstanceType<typeof HostBrowserExecutor>;

  beforeEach(() => {
    createdWebSockets = [];
    executor = new HostBrowserExecutor();
  });

  afterEach(() => {
    executor.destroy();
    mockFetchImpl = (async () => new Response("[]")) as unknown as typeof globalThis.fetch;
  });

  // -- Test seams -----------------------------------------------------------

  describe("test seams", () => {
    test("isLoopback accepts localhost, 127.0.0.1, ::1", () => {
      expect(__testing.isLoopback("localhost")).toBe(true);
      expect(__testing.isLoopback("127.0.0.1")).toBe(true);
      expect(__testing.isLoopback("::1")).toBe(true);
      expect(__testing.isLoopback("LOCALHOST")).toBe(true);
    });

    test("isLoopback rejects non-loopback hosts", () => {
      expect(__testing.isLoopback("192.168.1.1")).toBe(false);
      expect(__testing.isLoopback("evil.com")).toBe(false);
      expect(__testing.isLoopback("10.0.0.1")).toBe(false);
    });

    test("transportError returns structured error payload", () => {
      const err = __testing.transportError("req-1", "unreachable", "cannot connect");
      expect(err.requestId).toBe("req-1");
      expect(err.isError).toBe(true);
      const parsed = JSON.parse(err.content);
      expect(parsed.code).toBe("unreachable");
      expect(parsed.message).toBe("cannot connect");
    });
  });

  // -- Target discovery -----------------------------------------------------

  describe("target discovery", () => {
    test("filters to page targets only", async () => {
      const targets = [
        pageTarget("page-1"),
        { id: "worker-1", type: "service_worker", title: "SW" },
        pageTarget("page-2"),
        { id: "bg-1", type: "background_page", title: "BG" },
      ];
      setTargets(targets);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        { type: "host_browser_request", requestId: "r1", cdpMethod: "Runtime.evaluate", cdpParams: { expression: "1+1" } },
        poster,
      );

      await flush(50);
      // Should have created a WebSocket to the first page target
      expect(createdWebSockets.length).toBeGreaterThanOrEqual(1);
      expect(createdWebSockets[0].url).toContain("page-1");
    });

    test("returns unreachable error when Chrome is not running", async () => {
      setFetchError("Connection refused");

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        { type: "host_browser_request", requestId: "r1", cdpMethod: "Page.navigate" },
        poster,
      );

      await flush(50);
      expect(results.length).toBe(1);
      expect(results[0].isError).toBe(true);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.code).toBe("unreachable");
    });

    test("returns unreachable when no page targets exist", async () => {
      setTargets([
        { id: "sw-1", type: "service_worker", title: "SW" },
      ]);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        { type: "host_browser_request", requestId: "r1", cdpMethod: "Page.navigate" },
        poster,
      );

      await flush(50);
      expect(results.length).toBe(1);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.code).toBe("unreachable");
    });
  });

  // -- Session matching -----------------------------------------------------

  describe("session matching", () => {
    test("matches target by cdpSessionId", async () => {
      setTargets([pageTarget("target-A"), pageTarget("target-B")]);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        {
          type: "host_browser_request",
          requestId: "r1",
          cdpMethod: "Runtime.evaluate",
          cdpSessionId: "target-B",
        },
        poster,
      );

      await flush(50);
      expect(createdWebSockets.length).toBeGreaterThanOrEqual(1);
      expect(createdWebSockets[0].url).toContain("target-B");
    });

    test("fails closed when cdpSessionId does not match any target", async () => {
      setTargets([pageTarget("target-A")]);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        {
          type: "host_browser_request",
          requestId: "r1",
          cdpMethod: "Runtime.evaluate",
          cdpSessionId: "nonexistent",
        },
        poster,
      );

      await flush(50);
      expect(results.length).toBe(1);
      expect(results[0].isError).toBe(true);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.code).toBe("cdp_session_not_found");
    });
  });

  // -- Loopback validation --------------------------------------------------

  describe("loopback validation", () => {
    test("rejects non-loopback WebSocket URL from target", async () => {
      setTargets([
        pageTarget("page-1", "ws://evil.com:9222/devtools/page/page-1"),
      ]);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        { type: "host_browser_request", requestId: "r1", cdpMethod: "Page.navigate" },
        poster,
      );

      await flush(50);
      expect(results.length).toBe(1);
      expect(results[0].isError).toBe(true);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.code).toBe("non_loopback");
    });
  });

  // -- CDP command send/receive ---------------------------------------------

  describe("CDP command", () => {
    test("sends method and params, returns result", async () => {
      setTargets([pageTarget("page-1")]);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        {
          type: "host_browser_request",
          requestId: "r1",
          cdpMethod: "Runtime.evaluate",
          cdpParams: { expression: "document.title" },
        },
        poster,
      );

      await flush(50);
      const ws = createdWebSockets[0];
      expect(ws).toBeDefined();
      expect(ws.send).toHaveBeenCalled();

      // Parse the sent message to find command id
      const sentData = JSON.parse((ws.send as ReturnType<typeof mock>).mock.calls[0][0] as string);
      expect(sentData.method).toBe("Runtime.evaluate");
      expect(sentData.params.expression).toBe("document.title");

      // Reply
      replyToCDP(ws, sentData.id, { result: { type: "string", value: "Test Page" } });
      await flush(50);

      expect(results.length).toBe(1);
      expect(results[0].isError).toBe(false);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.result.value).toBe("Test Page");
    });

    test("returns CDP protocol error with isError true", async () => {
      setTargets([pageTarget("page-1")]);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        {
          type: "host_browser_request",
          requestId: "r1",
          cdpMethod: "DOM.getDocument",
        },
        poster,
      );

      await flush(50);
      const ws = createdWebSockets[0];
      const sentData = JSON.parse((ws.send as ReturnType<typeof mock>).mock.calls[0][0] as string);

      replyWithCDPError(ws, sentData.id, -32000, "Cannot find context");
      await flush(50);

      expect(results.length).toBe(1);
      expect(results[0].isError).toBe(true);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.code).toBe(-32000);
      expect(parsed.message).toBe("Cannot find context");
    });
  });

  // -- Timeout --------------------------------------------------------------

  describe("timeout", () => {
    test("times out after configured seconds", async () => {
      setTargets([pageTarget("page-1")]);

      const { poster, results } = capturingPoster();
      // Use a very short timeout for testing
      executor.handleRequest(
        {
          type: "host_browser_request",
          requestId: "r1",
          cdpMethod: "Page.navigate",
          timeout_seconds: 0.05,
        },
        poster,
      );

      // Wait longer than the timeout
      await flush(200);

      expect(results.length).toBe(1);
      expect(results[0].isError).toBe(true);
      const parsed = JSON.parse(results[0].content!);
      expect(parsed.code).toBe("timeout");
    });
  });

  // -- Cancellation ---------------------------------------------------------

  describe("cancellation", () => {
    test("pre-flight cancellation suppresses execution", async () => {
      setTargets([pageTarget("page-1")]);

      // Cancel before the request even starts executing
      executor.handleCancel(
        { type: "host_browser_cancel", requestId: "r1" },
        {} as import("../host-proxy-poster").HostProxyPoster,
      );

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        { type: "host_browser_request", requestId: "r1", cdpMethod: "Page.navigate" },
        poster,
      );

      await flush(100);
      // No result should be posted
      expect(results.length).toBe(0);
    });

    test("in-flight cancellation aborts pending request", async () => {
      setTargets([pageTarget("page-1")]);

      const { poster, results } = capturingPoster();
      executor.handleRequest(
        { type: "host_browser_request", requestId: "r1", cdpMethod: "Page.navigate" },
        poster,
      );

      await flush(50);
      // Cancel while in flight
      executor.handleCancel(
        { type: "host_browser_cancel", requestId: "r1" },
        poster,
      );

      await flush(100);
      // No successful result should be posted (timeout/cancel errors may or may not appear)
      const nonError = results.filter((r) => !r.isError);
      expect(nonError.length).toBe(0);
    });
  });

  // -- Missing requestId ---------------------------------------------------

  describe("edge cases", () => {
    test("ignores messages without requestId", () => {
      const { poster, results } = capturingPoster();
      executor.handleRequest(
        { type: "host_browser_request" },
        poster,
      );
      expect(results.length).toBe(0);
    });
  });
});
